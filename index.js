// ST Git Backup 2.0 — SillyTavern server plugin
// One-token onboarding: the user pastes a GitHub/Gitee PAT, the plugin
// verifies it, creates/adopts a private repo and configures everything.
// Backups are zip snapshots of the user's data directory stored in a git
// repo whose history is rewritten on every backup so the remote stays
// bounded (≈ keepSnapshots × one snapshot). Restore fetches a snapshot,
// unpacks it and overwrites the data directory (with a pre-restore safety
// snapshot pushed first, so any restore is reversible).
// Install: copy this folder into <SillyTavern>/plugins/st-git-backup, set
// enableServerPlugins: true in config.yaml and restart SillyTavern.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { zipDirectory, extractZip, copyInto, listFiles, sleep } = require('./lib/zipfile');

const PLUGIN_ID = 'st-git-backup';
const ST_ROOT = path.join(__dirname, '..', '..');
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
// Store lives outside the user data dir so snapshots never back up themselves.
const STORE_DIR = path.join(ST_ROOT, 'data', 'st-git-backup-store');
const SNAPSHOTS_DIR = path.join(STORE_DIR, 'snapshots');
const BARE_REPO = path.join(STORE_DIR, 'repo.git');
const META_FILE = path.join(STORE_DIR, 'meta.json');
const MARKER_V1 = '.st-git-backup'; // marker file written by plugin 1.x in the data dir

const GIT_TIMEOUT_MS = 10 * 60 * 1000;
const SNAPSHOT_PREFIX = 'snapshot-';
const DEFAULT_REPO_NAME = 'sillytavern-backup';
const TOKEN_MASK = '********';

// Directory/file names never included in snapshots, at any depth.
const EXCLUDED_NAMES = new Set(['.git', '.cache', 'thumbnails', 'vectors', 'backups', MARKER_V1]);

const DEFAULT_SETTINGS = {
    platform: '', // 'github' | 'gitee'
    token: '',
    repoOwner: '',
    repoName: DEFAULT_REPO_NAME,
    repoUrl: '', // manual override (advanced); empty = derived from platform/owner/name
    branch: 'main',
    keepSnapshots: 10,
    maxStoreMB: 400,
    autoBackupHours: 0,
    includeSecrets: false,
    dataDirOverride: '',
    gitPath: '', // empty = auto-detect
    authorName: 'ST Git Backup',
    authorEmail: 'st-git-backup@localhost',
};

let settings = loadSettings();
let meta = loadMeta();
let busy = false;
let autoTimer = null;

const info = {
    id: PLUGIN_ID,
    name: 'ST Git Backup',
    description: 'One-token cloud backup & restore for SillyTavern user data.',
};

// ---------- settings / meta ----------

function loadSettings() {
    try {
        return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
    } catch {
        return { ...DEFAULT_SETTINGS };
    }
}

function saveSettings() {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 4), 'utf8');
}

function loadMeta() {
    try {
        return JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
    } catch {
        return {};
    }
}

function saveMeta() {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 4), 'utf8');
}

function isConfigured() {
    return Boolean(settings.token && (settings.repoUrl || (settings.repoOwner && settings.repoName)));
}

function publicSettings() {
    return {
        ...settings,
        token: settings.token ? TOKEN_MASK : '',
        hasToken: Boolean(settings.token),
    };
}

function mergeSettings(body) {
    const allowed = [
        'repoUrl', 'branch', 'keepSnapshots', 'maxStoreMB', 'autoBackupHours',
        'includeSecrets', 'dataDirOverride', 'gitPath', 'repoName',
    ];
    for (const key of allowed) {
        if (key in body) {
            settings[key] = body[key];
        }
    }
    settings.branch = (settings.branch || 'main').trim() || 'main';
    settings.repoUrl = (settings.repoUrl || '').trim();
    saveSettings();
    scheduleAutoBackup();
    return publicSettings();
}

// ---------- errors ----------

class HttpError extends Error {
    constructor(message, { status = 500, extra = {} } = {}) {
        super(message);
        this.status = status;
        this.extra = extra;
    }
}

// ---------- git helpers ----------

function findGitExecutable() {
    if (settings.gitPath && fs.existsSync(settings.gitPath)) {
        return settings.gitPath;
    }
    const candidates = [];
    if (process.platform === 'win32') {
        candidates.push(
            path.join(ST_ROOT, '..', 'env', 'bin', 'git.exe'), // SillyTavernLauncher portable git
            path.join(ST_ROOT, '..', 'env', 'cmd', 'git.exe'),
            path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Git', 'cmd', 'git.exe'),
            path.join(process.env['LOCALAPPDATA'] || '', 'Programs', 'Git', 'cmd', 'git.exe'),
        );
    } else {
        candidates.push('/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git');
    }
    for (const candidate of candidates) {
        try {
            if (candidate && fs.existsSync(candidate)) {
                return candidate;
            }
        } catch {
            // ignore
        }
    }
    return 'git'; // rely on PATH as last resort
}

// Never let the PAT appear in error messages that reach the UI or the console.
function redact(text) {
    if (!settings.token) {
        return text;
    }
    return String(text).split(settings.token).join('***');
}

function runGit(args, cwd, { env = {}, input = null } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(findGitExecutable(), args, {
            cwd,
            env: { ...process.env, ...env },
            windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`git ${args[0]} 超时（${GIT_TIMEOUT_MS / 1000} 秒）`));
        }, GIT_TIMEOUT_MS);
        child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
        child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
        if (input !== null) {
            child.stdin.write(input);
        }
        child.stdin.end();
        child.on('error', (err) => {
            clearTimeout(timer);
            reject(new Error(redact(`无法启动 git（${err.message}）。如果 git 未安装，请在高级设置中设置 gitPath。`)));
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (code === 0) {
                resolve({ stdout, stderr });
            } else {
                reject(new Error(redact(`git ${args[0]} 失败: ${(stderr || stdout || `exit code ${code}`).trim()}`)));
            }
        });
    });
}

// HTTPS remote URL with the PAT injected for transport.
function authenticatedUrl() {
    const raw = effectiveRepoUrl();
    try {
        const url = new URL(raw);
        if (url.protocol === 'https:' && settings.token) {
            url.username = settings.platform === 'gitee' ? 'oauth2' : 'x-access-token';
            url.password = encodeURIComponent(settings.token);
        }
        return url.toString();
    } catch {
        return raw; // non-https URL (e.g. local file:// remote in tests)
    }
}

function effectiveRepoUrl() {
    if (settings.repoUrl) {
        return settings.repoUrl;
    }
    const owner = settings.repoOwner;
    const name = settings.repoName || DEFAULT_REPO_NAME;
    if (settings.platform === 'gitee') {
        return `https://gitee.com/${owner}/${name}.git`;
    }
    return `https://github.com/${owner}/${name}.git`;
}

// ---------- data directory ----------

function getDataDir(req) {
    if (settings.dataDirOverride) {
        return path.resolve(settings.dataDirOverride);
    }
    const fromRequest = req?.user?.directories?.root;
    if (fromRequest) {
        return path.resolve(fromRequest);
    }
    return path.join(ST_ROOT, 'data', 'default-user');
}

function isExcludedPath(relPath, includeSecrets) {
    const parts = relPath.split('/');
    if (parts.some((part) => EXCLUDED_NAMES.has(part))) {
        return true;
    }
    return !includeSecrets && parts[parts.length - 1] === 'secrets.json';
}

// Stable fingerprint of the data directory (paths + size + mtime).
function computeFingerprint(dataDir, includeSecrets) {
    const hash = crypto.createHash('sha256');
    const files = listFiles(dataDir, (rel) => isExcludedPath(rel, includeSecrets));
    files.sort((a, b) => (a.rel < b.rel ? -1 : 1));
    for (const file of files) {
        const stat = fs.statSync(file.abs);
        hash.update(`${file.rel}:${stat.size}:${Math.floor(stat.mtimeMs)}\n`);
    }
    return hash.digest('hex');
}

// ---------- snapshot store ----------

function ensureStore() {
    fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
    if (!fs.existsSync(path.join(BARE_REPO, 'HEAD'))) {
        // --bare: no working tree, we only use it as a transport for push/fetch
        return runGit(['init', '--bare', BARE_REPO], STORE_DIR).then(async () => {
            // commit-tree needs an author identity; a bare repo has none
            await runGit(['config', 'user.name', settings.authorName], BARE_REPO);
            await runGit(['config', 'user.email', settings.authorEmail], BARE_REPO);
        });
    }
    return Promise.resolve();
}

// snapshot-<timestamp>-<kind>.zip; fixed-width timestamp keeps names sortable.
function timestampSlug(date = new Date()) {
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

function localSnapshots() {
    try {
        return fs.readdirSync(SNAPSHOTS_DIR)
            .filter((name) => name.startsWith(SNAPSHOT_PREFIX) && name.endsWith('.zip'));
    } catch {
        return [];
    }
}

function snapshotName(date, kind) {
    return `${SNAPSHOT_PREFIX}${timestampSlug(date)}-${kind}.zip`;
}

// Keep only the newest keepSnapshots files, then enforce the size budget.
function pruneSnapshots() {
    let files = localSnapshots().sort(); // ascending: oldest first
    const keep = Math.max(1, Number(settings.keepSnapshots) || 10);
    let removed = [];
    while (files.length > keep) {
        const [oldest] = files.splice(0, 1);
        removed.push(oldest);
    }
    const budget = (Number(settings.maxStoreMB) || 400) * 1024 * 1024;
    const totalSize = () => files.reduce((sum, name) => sum + fs.statSync(path.join(SNAPSHOTS_DIR, name)).size, 0);
    while (files.length > 1 && totalSize() > budget) {
        const [oldest] = files.splice(0, 1);
        removed.push(oldest);
    }
    for (const name of removed) {
        try { fs.unlinkSync(path.join(SNAPSHOTS_DIR, name)); } catch { /* ignore */ }
    }
    return removed;
}

// Rebuild the bare repo's branch as a fresh chain containing exactly the
// current local snapshots (oldest first) — every commit's tree accumulates
// all snapshots up to that point, so the branch tip's tree always lists the
// full snapshot set. Uses commit-tree plumbing — no working tree, no index.
async function rebuildHistory() {
    const files = localSnapshots().sort();
    const entries = [];
    let parent = null;
    for (const name of files) {
        const { stdout: blob } = await runGit(['hash-object', '-w', path.join(SNAPSHOTS_DIR, name)], BARE_REPO);
        entries.push(`100644 blob ${blob.trim()}\t${name}`);
        const { stdout: tree } = await runGit(['mktree'], BARE_REPO, { input: entries.join('\n') + '\n' });
        const args = ['commit-tree', tree.trim(), '-m', `ST Git Backup ${name}`];
        if (parent) {
            args.push('-p', parent);
        }
        const { stdout: commit } = await runGit(args, BARE_REPO);
        parent = commit.trim();
    }
    if (parent) {
        await runGit(['update-ref', `refs/heads/${settings.branch}`, parent], BARE_REPO);
    }
    return parent;
}

// Fetch the remote branch. Returns null when the remote has no branch yet
// (fresh repo) — other fetch failures (auth, network) propagate so the real
// push below reports them with git's own message.
async function fetchRemoteBranch() {
    try {
        await runGit(['fetch', authenticatedUrl(), settings.branch], BARE_REPO);
        return 'fetched';
    } catch (err) {
        if (/couldn't find remote ref|not found|does not appear to be a git/i.test(err.message)) {
            return null; // empty repo — first backup ever
        }
        throw err;
    }
}

async function remoteSnapshotNames() {
    const fetched = await fetchRemoteBranch();
    if (!fetched) {
        return [];
    }
    try {
        const { stdout } = await runGit(['ls-tree', '-r', '--name-only', 'FETCH_HEAD'], BARE_REPO);
        return stdout.split('\n').map((line) => line.trim()).filter((name) => name.startsWith(SNAPSHOT_PREFIX) && name.endsWith('.zip'));
    } catch {
        return []; // branch exists but tree unreadable — treat as empty
    }
}

// The remote is "ahead" when its newest snapshot is newer than anything we
// have locally — i.e. another device backed up since our last backup.
function remoteHasNewerSnapshots(remoteNames, localNames) {
    if (remoteNames.length === 0) {
        return false;
    }
    const newestRemote = remoteNames.sort().slice(-1)[0];
    const newestLocal = localNames.length > 0 ? localNames.sort().slice(-1)[0] : '';
    return newestRemote > newestLocal;
}

async function pushHistory(commitSha) {
    await runGit(['push', '-f', authenticatedUrl(), `${commitSha}:refs/heads/${settings.branch}`], BARE_REPO);
}

// ---------- backup ----------

async function createSnapshot(dataDir, kind) {
    const name = snapshotName(new Date(), kind);
    const outPath = path.join(SNAPSHOTS_DIR, name);
    const result = await zipDirectory(dataDir, outPath, (rel) => isExcludedPath(rel, settings.includeSecrets));
    return { name, ...result };
}

async function performBackup(dataDir, { kind = 'manual', confirmOverwrite = false, force = false } = {}) {
    if (!isConfigured()) {
        throw new HttpError('尚未配置云端仓库，请先粘贴 Token 完成接入', { status: 400 });
    }
    await ensureStore();

    // conflict check before any work — a pending confirm must not be lost
    if (!confirmOverwrite) {
        const remoteNames = await remoteSnapshotNames();
        if (remoteHasNewerSnapshots(remoteNames, localSnapshots())) {
            throw new HttpError('云端已有比本机更新的备份（可能来自其他设备）。直接备份将覆盖它，那份数据会丢失。', {
                status: 409,
                extra: { needConfirm: true, remoteNewest: remoteNames.sort().slice(-1)[0] },
            });
        }
    }

    const fingerprint = computeFingerprint(dataDir, settings.includeSecrets);
    // With confirmOverwrite the user accepted clobbering a newer remote
    // snapshot — push even when our data is unchanged, otherwise the accepted
    // overwrite would silently never happen.
    if (!force && !confirmOverwrite && fingerprint === meta.lastBackupFingerprint && meta.lastSnapshotName) {
        return { skipped: true, reason: '数据无变化', snapshot: meta.lastSnapshotName };
    }

    const snapshot = await createSnapshot(dataDir, kind);
    pruneSnapshots();
    const commitSha = await rebuildHistory();
    if (commitSha) {
        await pushHistory(commitSha);
    }
    meta.lastBackupFingerprint = fingerprint;
    meta.lastSnapshotName = snapshot.name;
    meta.lastBackupAt = new Date().toISOString();
    saveMeta();
    return { skipped: false, snapshot: snapshot.name, size: snapshot.size, files: snapshot.fileCount, commit: commitSha };
}

// ---------- restore ----------

async function extractSnapshotFromRemote(name, outPath) {
    // `git ls-tree -r FETCH_HEAD -- <path>` prints "<mode> blob <sha>\t<path>"
    const { stdout: line } = await runGit(['ls-tree', '-r', 'FETCH_HEAD', '--', name], BARE_REPO);
    const sha = line.trim().split(/\s+/)[2];
    if (!sha) {
        throw new HttpError(`远端没有找到快照 ${name}`, { status: 404 });
    }
    // cat-file writes binary to stdout; spawn captured it as utf8 would corrupt
    // the zip bytes — use the dedicated file-redirecting runner.
    await runGitToFile(['cat-file', 'blob', sha], outPath);
    return outPath;
}

// Binary-safe variant of runGit that redirects stdout straight to a file.
function runGitToFile(args, outPath) {
    return new Promise((resolve, reject) => {
        const child = spawn(findGitExecutable(), args, { cwd: BARE_REPO, windowsHide: true });
        const out = fs.createWriteStream(outPath);
        child.stdout.pipe(out);
        let stderr = '';
        child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
        child.on('error', (err) => reject(new Error(redact(`无法启动 git（${err.message}）`))));
        out.on('error', reject);
        out.on('close', () => {
            if (out.bytesWritten === 0) {
                reject(new Error(redact(`git ${args[0]} 失败: ${stderr.trim() || '无输出'}`)));
            } else {
                resolve();
            }
        });
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error('git 超时'));
        }, GIT_TIMEOUT_MS);
        child.on('close', () => clearTimeout(timer));
    });
}

// Delete files that exist in dataDir but not in the snapshot, but never touch
// excluded paths (thumbnails/vectors/backups are outside the snapshot's
// contract; secrets.json must survive when excluded).
function removeUnstagedFiles(dataDir, stagedRelPaths) {
    let removed = 0;
    const walk = (dir, rel) => {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const relPath = rel ? `${rel}/${entry.name}` : entry.name;
            if (isExcludedPath(relPath, settings.includeSecrets)) {
                continue;
            }
            const abs = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(abs, relPath);
            } else if (entry.isFile() && !stagedRelPaths.has(relPath)) {
                try { fs.unlinkSync(abs); removed++; } catch { /* locked — leave it */ }
            }
        }
    };
    walk(dataDir, '');
    return removed;
}

async function performRestore(dataDir, requestedSnapshot) {
    if (!isConfigured()) {
        throw new HttpError('尚未配置云端仓库，请先粘贴 Token 完成接入', { status: 400 });
    }
    await ensureStore();

    // Resolve the target snapshot FIRST and pin its bytes to a temp file —
    // the safety snapshot below adds a new entry and prunes the store, which
    // must never evict the snapshot we are about to restore.
    const localCandidates = localSnapshots().sort();
    let targetName = requestedSnapshot || '';
    let targetSource = null; // { type: 'file', path } | { type: 'remote' }
    if (requestedSnapshot) {
        const localFile = path.join(SNAPSHOTS_DIR, requestedSnapshot);
        if (fs.existsSync(localFile)) {
            targetSource = { type: 'file', path: localFile };
        } else {
            const remoteNames = await remoteSnapshotNames();
            if (!remoteNames.includes(requestedSnapshot)) {
                throw new HttpError(`快照 ${requestedSnapshot} 在本地和云端都不存在`, { status: 404 });
            }
            targetSource = { type: 'remote' };
        }
    } else {
        const remoteNames = await remoteSnapshotNames();
        // auto-select the newest real snapshot; pre-restore safety snapshots
        // are only restore points by explicit choice (restoring "latest" must
        // never pick the safety snapshot it just created)
        const union = [...new Set([...localCandidates, ...remoteNames])]
            .filter((name) => !name.includes('-pre-restore'))
            .sort();
        targetName = union.slice(-1)[0];
        if (!targetName) {
            throw new HttpError('云端和本地都没有任何快照，无法恢复', { status: 400 });
        }
        const localFile = path.join(SNAPSHOTS_DIR, targetName);
        targetSource = fs.existsSync(localFile) ? { type: 'file', path: localFile } : { type: 'remote' };
    }
    const pinnedPath = path.join(os.tmpdir(), `stgb-restore-${Date.now()}.zip`);
    if (targetSource.type === 'file') {
        fs.copyFileSync(targetSource.path, pinnedPath);
    }

    // Safety net: snapshot the current local state and try to push it,
    // so this restore can always be undone.
    let safetySnapshot = null;
    const dataFiles = listFiles(dataDir, (rel) => isExcludedPath(rel, settings.includeSecrets));
    if (dataFiles.length > 0) {
        try {
            const snapshot = await createSnapshot(dataDir, 'pre-restore');
            safetySnapshot = snapshot.name;
            pruneSnapshots();
            const commitSha = await rebuildHistory();
            if (commitSha) {
                await pushHistory(commitSha);
            }
        } catch (err) {
            console.error(`[${PLUGIN_ID}] safety snapshot failed:`, err.message);
            safetySnapshot = null;
        }
    }

    let targetPath = pinnedPath;
    try {
        if (targetSource.type === 'remote') {
            // FETCH_HEAD still points at the pre-safety remote state, which
            // contained the target — the safety push below doesn't touch it.
            targetPath = path.join(os.tmpdir(), `stgb-remote-${Date.now()}.zip`);
            await extractSnapshotFromRemote(targetName, targetPath);
        }

        // Unpack to a staging dir first so a corrupt zip can't half-clobber data.
        const stagingDir = path.join(STORE_DIR, `staging-${Date.now()}`);
        let stagedCount;
        try {
            stagedCount = await extractZip(targetPath, stagingDir);
            if (stagedCount === 0) {
                throw new Error('压缩包内没有文件');
            }
            copyInto(stagingDir, dataDir);
            const stagedRel = new Set(listFiles(stagingDir, () => false).map((f) => f.rel));
            const removed = removeUnstagedFiles(dataDir, stagedRel);
            meta.lastRestoreAt = new Date().toISOString();
            meta.lastBackupFingerprint = computeFingerprint(dataDir, settings.includeSecrets);
            saveMeta();
            return { snapshot: targetName, restoredFiles: stagedCount, removedFiles: removed, safetySnapshot, restartRequired: true };
        } finally {
            fs.rmSync(stagingDir, { recursive: true, force: true });
        }
    } finally {
        fs.rmSync(pinnedPath, { force: true });
        if (targetPath !== pinnedPath) {
            fs.rmSync(targetPath, { force: true });
        }
    }
}

// ---------- snapshot list ----------

async function listSnapshots({ refresh = false } = {}) {
    const local = localSnapshots().sort();
    let remote = [];
    if (refresh && isConfigured()) {
        await ensureStore();
        try {
            remote = await remoteSnapshotNames();
        } catch (err) {
            throw new HttpError(`获取云端快照失败: ${err.message}`, { status: 502 });
        }
    }
    const union = [...new Set([...local, ...remote])].sort().reverse();
    return union.map((name) => ({
        name,
        local: local.includes(name),
        remote: remote.includes(name) || (refresh ? false : null),
        size: (() => {
            const p = path.join(SNAPSHOTS_DIR, name);
            try { return fs.statSync(p).size; } catch { return null; }
        })(),
    }));
}

// ---------- onboarding (provision) ----------

async function apiJson(url, options = {}, timeoutMs = 10000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal,
            headers: {
                'User-Agent': PLUGIN_ID,
                'Content-Type': 'application/json',
                ...(options.headers || {}),
            },
        });
        const text = await response.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
        return { status: response.status, ok: response.ok, data };
    } finally {
        clearTimeout(timer);
    }
}

function isGithubToken(token) {
    return /^(ghp_|gho_|ghu_|ghs_|github_pat_)/.test(token);
}

async function verifyToken(token) {
    const probeGithub = async () => {
        const { status, ok, data } = await apiJson('https://api.github.com/user', {
            headers: { Authorization: `Bearer ${token}` },
        });
        if (ok) {
            return { platform: 'github', login: data.login };
        }
        if (status === 401) {
            throw new HttpError('GitHub 拒绝了这个 Token（已过期或填写错误）', { status: 400 });
        }
        throw new HttpError(`无法验证 GitHub Token（HTTP ${status}）。如果所在网络访问 GitHub 困难，建议使用 Gitee。`, { status: 502 });
    };
    const probeGitee = async () => {
        const { status, ok, data } = await apiJson(`https://gitee.com/api/v5/user?access_token=${encodeURIComponent(token)}`);
        if (ok) {
            return { platform: 'gitee', login: data.login };
        }
        if (status === 401) {
            throw new HttpError('Gitee 拒绝了这个令牌（已过期或填写错误）', { status: 400 });
        }
        throw new HttpError(`无法验证 Gitee 令牌（HTTP ${status}）`, { status: 502 });
    };

    // Prefixed GitHub tokens go straight to GitHub; bare tokens (Gitee style)
    // probe Gitee first so users behind a GitHub-blocking network aren't stuck.
    const order = isGithubToken(token) ? [probeGithub, probeGitee] : [probeGitee, probeGithub];
    let lastError = null;
    for (const probe of order) {
        try {
            return await probe();
        } catch (err) {
            lastError = err;
            if (err instanceof HttpError && err.status === 400) {
                throw err; // definitively rejected — don't try the other platform
            }
        }
    }
    throw lastError || new HttpError('无法验证 Token', { status: 502 });
}

async function ensureRemoteRepo(platform, token, login, repoName) {
    if (platform === 'github') {
        const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };
        const get = await apiJson(`https://api.github.com/repos/${encodeURIComponent(login)}/${encodeURIComponent(repoName)}`, { headers });
        if (get.ok) {
            return { created: false };
        }
        const create = await apiJson('https://api.github.com/user/repos', {
            method: 'POST',
            headers,
            body: JSON.stringify({ name: repoName, private: true, auto_init: false }),
        });
        if (create.ok || create.status === 422) { // 422 = already exists
            const recheck = await apiJson(`https://api.github.com/repos/${encodeURIComponent(login)}/${encodeURIComponent(repoName)}`, { headers });
            if (recheck.ok) {
                return { created: create.ok };
            }
            throw new HttpError(`仓库 ${repoName} 已存在于你的账号，但当前 Token 无权访问它。请检查 Token 权限（需要 Contents 读写）。`, { status: 400 });
        }
        if (create.status === 401 || create.status === 403 || create.status === 404) {
            throw new HttpError('Token 权限不足，无法创建仓库。GitHub fine-grained Token 需要 Administration（写）+ Contents（读写）权限；classic Token 勾选 repo 即可。也可以在高级设置里手动填一个已有仓库地址。', { status: 400 });
        }
        throw new HttpError(`GitHub 建仓失败（HTTP ${create.status}）`, { status: 502 });
    }

    // gitee
    const get = await apiJson(`https://gitee.com/api/v5/repos/${encodeURIComponent(login)}/${encodeURIComponent(repoName)}?access_token=${encodeURIComponent(token)}`);
    if (get.ok) {
        return { created: false };
    }
    const create = await apiJson('https://gitee.com/api/v5/user/repos', {
        method: 'POST',
        body: JSON.stringify({ access_token: token, name: repoName, private: true, auto_init: false }),
    });
    if (create.ok || create.status === 400 && /exist/i.test(JSON.stringify(create.data || ''))) {
        return { created: create.ok };
    }
    if (create.status === 401 || create.status === 403) {
        throw new HttpError('令牌权限不足，无法创建仓库。Gitee 私人令牌需要勾选 projects 权限。也可以在高级设置里手动填一个已有仓库地址。', { status: 400 });
    }
    throw new HttpError(`Gitee 建仓失败（HTTP ${create.status}）`, { status: 502 });
}

async function provision(token) {
    if (!token) {
        throw new HttpError('请粘贴 Token', { status: 400 });
    }
    const { platform, login } = await verifyToken(token);
    const repoName = settings.repoName || DEFAULT_REPO_NAME;

    if (settings.repoUrl) {
        // Manual override (advanced): skip creation, trust the URL.
    } else {
        await ensureRemoteRepo(platform, token, login, repoName);
    }

    settings.platform = platform;
    settings.token = token;
    settings.repoOwner = login;
    settings.repoName = repoName;
    saveSettings();

    // Verify git-level access with the freshly stored token.
    const { stdout } = await runGit(['ls-remote', authenticatedUrl()], os.tmpdir());
    const remoteHasSnapshots = /refs\/heads\//.test(stdout);

    scheduleAutoBackup();
    return { platform, login, repo: repoName, remoteHasSnapshots };
}

async function testConnection() {
    if (!isConfigured()) {
        throw new HttpError('尚未配置云端仓库', { status: 400 });
    }
    const { stdout } = await runGit(['ls-remote', authenticatedUrl()], os.tmpdir());
    return { refs: stdout.split('\n').filter((line) => line.trim()).length };
}

// ---------- legacy (v1) cleanup ----------

function legacyRepoDetected(dataDir) {
    return fs.existsSync(path.join(dataDir, '.git')) && fs.existsSync(path.join(dataDir, MARKER_V1));
}

function cleanupLegacyRepo(dataDir) {
    if (!legacyRepoDetected(dataDir)) {
        return { removed: false };
    }
    fs.rmSync(path.join(dataDir, '.git'), { recursive: true, force: true });
    fs.rmSync(path.join(dataDir, MARKER_V1), { force: true });
    // strip the v1 managed .gitignore block
    const gitignore = path.join(dataDir, '.gitignore');
    try {
        const existing = fs.readFileSync(gitignore, 'utf8');
        const cleaned = existing
            .replace(/# >>> st-git-backup managed >>>[\s\S]*?# <<< st-git-backup managed <<<\n?/g, '')
            .replace(/^\n+/, '');
        if (cleaned.trim()) {
            fs.writeFileSync(gitignore, cleaned, 'utf8');
        } else {
            fs.rmSync(gitignore, { force: true });
        }
    } catch { /* no .gitignore */ }
    return { removed: true };
}

// ---------- auto backup ----------

function scheduleAutoBackup() {
    if (autoTimer) {
        clearInterval(autoTimer);
        autoTimer = null;
    }
    const hours = Number(settings.autoBackupHours);
    if (!Number.isFinite(hours) || hours <= 0) {
        return;
    }
    autoTimer = setInterval(() => {
        if (busy || !isConfigured()) {
            return;
        }
        busy = true;
        performBackup(getDataDir(null), { kind: 'auto' })
            .catch((err) => console.error(`[${PLUGIN_ID}] auto backup failed:`, err.message))
            .finally(() => { busy = false; });
    }, hours * 3600 * 1000);
    console.log(`[${PLUGIN_ID}] auto backup scheduled every ${hours}h`);
}

// ---------- HTTP plumbing ----------

function wrap(handler) {
    return async (req, res) => {
        try {
            const data = await handler(req, res);
            if (data !== undefined) {
                res.json(data);
            }
        } catch (err) {
            const status = err instanceof HttpError ? err.status : 500;
            console.error(`[${PLUGIN_ID}]`, err);
            res.status(status).json({ error: err.message, ...(err.extra || {}) });
        }
    };
}

async function init(router) {
    router.get('/info', wrap(async (req) => {
        const dataDir = getDataDir(req);
        let gitVersion = null;
        try {
            gitVersion = (await runGit(['version'])).stdout.trim();
        } catch { /* git missing */ }
        return {
            plugin: PLUGIN_ID,
            version: '2.0.0',
            gitVersion,
            dataDir,
            configured: isConfigured(),
            platform: settings.platform,
            repo: settings.repoUrl || (settings.repoOwner ? `${settings.repoOwner}/${settings.repoName}` : ''),
            snapshotCount: localSnapshots().length,
            lastBackupAt: meta.lastBackupAt || null,
            lastSnapshotName: meta.lastSnapshotName || null,
            lastRestoreAt: meta.lastRestoreAt || null,
            autoBackupHours: settings.autoBackupHours,
            storeDir: STORE_DIR,
            legacyRepoDetected: legacyRepoDetected(dataDir),
            busy,
        };
    }));

    router.get('/settings', wrap(async () => publicSettings()));

    router.post('/settings', wrap(async (req) => mergeSettings(req.body || {})));

    router.post('/provision', wrap(async (req) => {
        if (busy) {
            throw new HttpError('另一个备份/恢复操作正在进行中', { status: 409 });
        }
        busy = true;
        try {
            return await provision((req.body || {}).token);
        } finally {
            busy = false;
        }
    }));

    router.all('/test', wrap(async () => testConnection()));

    router.post('/backup', wrap(async (req) => {
        if (busy) {
            throw new HttpError('另一个备份/恢复操作正在进行中', { status: 409 });
        }
        busy = true;
        try {
            const body = req.body || {};
            return await performBackup(getDataDir(req), {
                kind: 'manual',
                confirmOverwrite: body.confirmOverwrite === true,
                force: body.force === true,
            });
        } finally {
            busy = false;
        }
    }));

    router.get('/snapshots', wrap(async (req) => {
        if (busy) {
            throw new HttpError('另一个备份/恢复操作正在进行中', { status: 409 });
        }
        const refresh = (req.query || {}).refresh === '1';
        if (refresh) {
            busy = true;
            try {
                return { snapshots: await listSnapshots({ refresh: true }) };
            } finally {
                busy = false;
            }
        }
        return { snapshots: await listSnapshots({ refresh: false }) };
    }));

    router.post('/restore', wrap(async (req) => {
        const body = req.body || {};
        if (body.confirm !== true) {
            throw new HttpError('恢复操作需要 { confirm: true }', { status: 400 });
        }
        if (busy) {
            throw new HttpError('另一个备份/恢复操作正在进行中', { status: 409 });
        }
        busy = true;
        try {
            return await performRestore(getDataDir(req), body.snapshot || null);
        } finally {
            busy = false;
        }
    }));

    router.post('/cleanup-legacy', wrap(async (req) => cleanupLegacyRepo(getDataDir(req))));

    scheduleAutoBackup();
    console.log(`[${PLUGIN_ID}] server plugin 2.0 initialized`);
}

function exit() {
    if (autoTimer) {
        clearInterval(autoTimer);
        autoTimer = null;
    }
}

module.exports = { info, init, exit, _internal: {
    loadSettings, saveSettings, findGitExecutable, runGit, authenticatedUrl,
    effectiveRepoUrl, ensureStore, rebuildHistory, pushHistory, pruneSnapshots,
    createSnapshot, performBackup, performRestore, listSnapshots, provision,
    verifyToken, ensureRemoteRepo, computeFingerprint, remoteSnapshotNames,
    remoteHasNewerSnapshots, localSnapshots, getDataDir, cleanupLegacyRepo,
    snapshotName, timestampSlug,
    get settings() { return settings; },
    set settings(value) { settings = value; },
    get meta() { return meta; },
    set meta(value) { meta = value; },
    get busy() { return busy; },
    set busy(value) { busy = value; },
} };
