// ST Git Backup — SillyTavern server plugin
// Backs up / restores the current user's data directory to a git remote.
// Install: copy this folder into <SillyTavern>/plugins/st-git-backup and set
// enableServerPlugins: true in config.yaml, then restart SillyTavern.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const PLUGIN_ID = 'st-git-backup';
const MARKER_FILE = '.st-git-backup';
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
// plugin lives at <SillyTavern>/plugins/st-git-backup/ -> server root two levels up
const ST_ROOT = path.join(__dirname, '..', '..');
const GIT_TIMEOUT_MS = 10 * 60 * 1000;

const DEFAULT_SETTINGS = {
    repoUrl: '',
    branch: 'main',
    authType: 'none', // 'none' | 'ssh' | 'pat'
    sshKeyPath: '',
    token: '',
    includeSecrets: false,
    autoBackupHours: 0,
    dataDirOverride: '',
    gitPath: '', // empty = auto-detect
    authorName: 'ST Git Backup',
    authorEmail: 'st-git-backup@localhost',
};

const TOKEN_MASK = '********';
const INLINE_KEY_FILE = path.join(__dirname, 'deploy_key_inline');

function isPastedPrivateKey(value) {
    return typeof value === 'string' && value.trim().startsWith('-----BEGIN');
}

// The SSH key field accepts either a file path or the key content itself
// (pasted). Pasted content is written to a plugin-local file and its path
// is stored instead, so the rest of the pipeline always deals with a file.
function resolveSshKeyPath(raw) {
    if (!isPastedPrivateKey(raw)) {
        return (raw || '').trim();
    }
    const content = raw.trim().replace(/\r\n/g, '\n') + '\n';
    fs.writeFileSync(INLINE_KEY_FILE, content, 'utf8');
    try {
        fs.chmodSync(INLINE_KEY_FILE, 0o600);
    } catch {
        // best effort — Windows MSYS ssh tolerates default file ACLs
    }
    return INLINE_KEY_FILE;
}

let settings = loadSettings();
let busy = false;
let autoTimer = null;

const info = {
    id: PLUGIN_ID,
    name: 'ST Git Backup',
    description: 'Backup and restore SillyTavern user data to a git repository.',
};

function loadSettings() {
    try {
        const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
        return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch {
        return { ...DEFAULT_SETTINGS };
    }
}

function saveSettings() {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 4), 'utf8');
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

function runGit(args, cwd, extraEnv = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(findGitExecutable(), args, {
            cwd,
            env: { ...process.env, ...extraEnv },
            windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`git ${args[0]} timed out after ${GIT_TIMEOUT_MS / 1000}s`));
        }, GIT_TIMEOUT_MS);
        child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
        child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
        child.on('error', (err) => {
            clearTimeout(timer);
            reject(new Error(`Failed to start git (${err.message}). Set "gitPath" in plugin settings if git is not on PATH.`));
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (code === 0) {
                resolve({ stdout, stderr });
            } else {
                const message = (stderr || stdout || `exit code ${code}`).trim();
                reject(new Error(`git ${args.join(' ')} failed: ${message}`));
            }
        });
    });
}

function buildEnv() {
    const env = {};
    if (settings.authType === 'ssh' && settings.sshKeyPath) {
        const key = settings.sshKeyPath.replace(/"/g, '');
        env.GIT_SSH_COMMAND = `ssh -i "${key}" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`;
    }
    return env;
}

// Remote URL to use for a network operation, injecting the PAT if needed.
function remoteUrl(rawUrl) {
    if (settings.authType !== 'pat' || !settings.token) {
        return rawUrl;
    }
    try {
        const url = new URL(rawUrl);
        if (url.protocol !== 'https:') {
            throw new Error('PAT auth requires an https:// repository URL');
        }
        url.username = 'x-access-token';
        url.password = encodeURIComponent(settings.token);
        return url.toString();
    } catch (err) {
        throw new Error(`Invalid repository URL: ${err.message}`);
    }
}

function sanitizeRemoteUrl(rawUrl) {
    try {
        const url = new URL(rawUrl);
        url.username = '';
        url.password = '';
        return url.toString();
    } catch {
        return rawUrl;
    }
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

function buildGitignore(settings) {
    const lines = [
        '# >>> st-git-backup managed >>>',
    ];
    if (!settings.includeSecrets) {
        lines.push('secrets.json');
    }
    lines.push(
        'backups/',
        'thumbnails/',
        'vectors/',
        '.cache/',
        '# <<< st-git-backup managed <<<',
    );
    return lines.join('\n') + '\n';
}

function writeGitignore(dataDir) {
    const file = path.join(dataDir, '.gitignore');
    let existing = '';
    try {
        existing = fs.readFileSync(file, 'utf8');
    } catch {
        // no existing file
    }
    const start = existing.indexOf('# >>> st-git-backup managed >>>');
    const end = existing.indexOf('# <<< st-git-backup managed <<<');
    let preserved = '';
    if (start !== -1 && end !== -1) {
        preserved = (existing.slice(0, start) + existing.slice(end + '# <<< st-git-backup managed <<<'.length)).replace(/^\n+/, '');
    } else if (start === -1) {
        preserved = existing;
    }
    fs.writeFileSync(file, buildGitignore(settings) + (preserved ? '\n' + preserved : ''), 'utf8');
}

async function ensureRepo(dataDir) {
    if (!fs.existsSync(dataDir)) {
        throw new Error(`Data directory does not exist: ${dataDir}`);
    }
    const gitDir = path.join(dataDir, '.git');
    const markerPath = path.join(dataDir, MARKER_FILE);

    if (fs.existsSync(gitDir) && !fs.existsSync(markerPath)) {
        throw new Error('REFUSE_FOREIGN_REPO');
    }

    if (!fs.existsSync(gitDir)) {
        const branch = settings.branch || 'main';
        try {
            await runGit(['init', '-b', branch], dataDir);
        } catch {
            // older git without -b
            await runGit(['init'], dataDir);
            await runGit(['symbolic-ref', 'HEAD', `refs/heads/${branch}`], dataDir);
        }
    }

    if (!fs.existsSync(markerPath)) {
        fs.writeFileSync(markerPath, JSON.stringify({ plugin: PLUGIN_ID, createdAt: new Date().toISOString() }, null, 4), 'utf8');
    }
    writeGitignore(dataDir);

    await runGit(['config', 'user.name', settings.authorName], dataDir);
    await runGit(['config', 'user.email', settings.authorEmail], dataDir);
    // never let line-ending conversion rewrite the whole tree
    await runGit(['config', 'core.autocrlf', 'false'], dataDir);

    if (settings.repoUrl) {
        const clean = settings.authType === 'pat' ? sanitizeRemoteUrl(settings.repoUrl) : settings.repoUrl;
        const remotes = await runGit(['remote'], dataDir);
        if (remotes.stdout.split(/\s+/).includes('origin')) {
            await runGit(['remote', 'set-url', 'origin', clean], dataDir);
        } else {
            await runGit(['remote', 'add', 'origin', clean], dataDir);
        }
    }
}

async function currentBranch(dataDir) {
    const { stdout } = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], dataDir);
    return stdout.trim();
}

// ---------- operations ----------

async function performBackup(dataDir, message) {
    await ensureRepo(dataDir);
    await runGit(['add', '-A'], dataDir);
    const status = await runGit(['status', '--porcelain'], dataDir);
    const result = { committed: false, pushed: false, commit: null };

    if (status.stdout.trim().length > 0) {
        const commitMessage = message || `ST Git Backup ${new Date().toISOString()}`;
        await runGit(['commit', '-m', commitMessage], dataDir);
        result.committed = true;
    }

    try {
        const head = await runGit(['rev-parse', '--verify', 'HEAD'], dataDir);
        result.commit = head.stdout.trim();
    } catch {
        // empty repo, nothing to push yet
    }

    // push even when the working tree was clean — local commits may exist
    // that were never pushed (e.g. remote was configured after committing)
    if (settings.repoUrl && result.commit) {
        const branch = await currentBranch(dataDir);
        const pushTarget = remoteUrl(settings.repoUrl);
        await runGit(['push', pushTarget, `HEAD:refs/heads/${branch}`], dataDir, buildEnv());
        result.pushed = true;
    }
    return result;
}

async function performRestore(dataDir, commitRef) {
    await ensureRepo(dataDir);
    if (settings.repoUrl) {
        const branch = settings.branch || 'main';
        await runGit(['fetch', remoteUrl(settings.repoUrl), branch], dataDir, buildEnv());
    }
    const target = commitRef || 'FETCH_HEAD';
    await runGit(['reset', '--hard', target], dataDir);
    const head = await runGit(['rev-parse', 'HEAD'], dataDir);
    return { commit: head.stdout.trim() };
}

async function getLog(dataDir, shouldFetch) {
    await ensureRepo(dataDir);
    if (shouldFetch && settings.repoUrl) {
        const branch = settings.branch || 'main';
        await runGit(['fetch', remoteUrl(settings.repoUrl), branch], dataDir, buildEnv());
    }
    const { stdout } = await runGit(
        ['log', '-n', '50', '--pretty=format:%H%x1f%h%x1f%cI%x1f%s'],
        dataDir,
    ).catch(() => ({ stdout: '' }));
    return stdout
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => {
            const [hash, short, date, subject] = line.split('\x1f');
            return { hash, short, date, subject };
        });
}

async function testConnection() {
    if (!settings.repoUrl) {
        throw new Error('Repository URL is not configured');
    }
    const { stdout } = await runGit(['ls-remote', remoteUrl(settings.repoUrl)], os.tmpdir(), buildEnv());
    return { refs: stdout.split('\n').filter((l) => l.trim()).length };
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
        const dataDir = getDataDir(null);
        performBackup(dataDir, `Auto backup ${new Date().toISOString()}`)
            .catch((err) => console.error(`[${PLUGIN_ID}] auto backup failed: ${err.message}`));
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
            console.error(`[${PLUGIN_ID}]`, err);
            const foreign = err.message === 'REFUSE_FOREIGN_REPO';
            res.status(foreign ? 409 : 500).json({
                error: foreign
                    ? 'The data directory already contains a git repository that was not created by this plugin. Remove or take over that .git folder first.'
                    : err.message,
            });
        }
    };
}

function publicSettings() {
    return { ...settings, token: settings.token ? TOKEN_MASK : '', hasToken: Boolean(settings.token) };
}

function mergeSettings(body) {
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (!(key in body)) {
            continue;
        }
        if (key === 'token' && body[key] === TOKEN_MASK) {
            continue; // keep stored token when the UI sends back the mask
        }
        if (key === 'sshKeyPath') {
            settings[key] = resolveSshKeyPath(body[key]);
            continue;
        }
        settings[key] = body[key];
    }
    saveSettings();
    scheduleAutoBackup();
    return publicSettings();
}

async function init(router) {
    router.get('/info', wrap(async (req) => {
        const dataDir = getDataDir(req);
        let gitVersion = null;
        try {
            const { stdout } = await runGit(['version']);
            gitVersion = stdout.trim();
        } catch {
            // git missing
        }
        const repoInitialized = fs.existsSync(path.join(dataDir, MARKER_FILE));
        let lastCommit = null;
        if (repoInitialized) {
            try {
                const { stdout } = await runGit(['log', '-1', '--pretty=format:%h %cI %s'], dataDir);
                lastCommit = stdout.trim();
            } catch {
                // empty repo
            }
        }
        return {
            plugin: PLUGIN_ID,
            gitVersion,
            dataDir,
            repoInitialized,
            lastCommit,
            remoteConfigured: Boolean(settings.repoUrl),
            busy,
        };
    }));

    router.get('/settings', wrap(async () => publicSettings()));

    router.post('/settings', wrap(async (req) => mergeSettings(req.body || {})));

    router.post('/test', wrap(async () => testConnection()));

    router.post('/backup', wrap(async (req) => {
        if (busy) {
            throw new Error('Another backup/restore operation is already running');
        }
        busy = true;
        try {
            const result = await performBackup(getDataDir(req), (req.body || {}).message);
            return { ok: true, ...result };
        } finally {
            busy = false;
        }
    }));

    router.post('/restore', wrap(async (req) => {
        const body = req.body || {};
        if (body.confirm !== true) {
            throw new Error('Restore requires { confirm: true }');
        }
        if (busy) {
            throw new Error('Another backup/restore operation is already running');
        }
        busy = true;
        try {
            const result = await performRestore(getDataDir(req), body.commit);
            return { ok: true, restartRequired: true, ...result };
        } finally {
            busy = false;
        }
    }));

    router.get('/log', wrap(async (req) => {
        const shouldFetch = (req.query || {}).fetch === '1';
        return { commits: await getLog(getDataDir(req), shouldFetch) };
    }));

    scheduleAutoBackup();
    console.log(`[${PLUGIN_ID}] server plugin initialized`);
}

function exit() {
    if (autoTimer) {
        clearInterval(autoTimer);
        autoTimer = null;
    }
}

module.exports = { info, init, exit, _internal: {
    loadSettings, saveSettings, findGitExecutable, runGit, ensureRepo,
    performBackup, performRestore, getLog, testConnection,
    buildGitignore, writeGitignore, remoteUrl, sanitizeRemoteUrl, getDataDir,
    resolveSshKeyPath, isPastedPrivateKey,
    INLINE_KEY_FILE,
    get settings() { return settings; },
    set settings(value) { settings = value; },
} };
