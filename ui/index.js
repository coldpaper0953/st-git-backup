// ST Git Backup 2.0 — SillyTavern UI extension
// One-token onboarding: paste a GitHub/Gitee PAT, the server plugin does the
// rest. All git/zip work happens server-side (/api/plugins/st-git-backup).
// Zero-import style: everything via global SillyTavern.getContext().

const STGB_PLUGIN_ID = 'st-git-backup';
const STGB_API_BASE = `/api/plugins/${STGB_PLUGIN_ID}`;

// ST loads extension entries as <script type="module">, so import.meta.url is
// reliable regardless of how the folder was named or installed.
const STGB_BASE_URL = new URL('.', import.meta.url).href;

function stgbLog(...args) {
    console.log('[st-git-backup]', ...args);
}

function stgbGetContext() {
    return SillyTavern.getContext();
}

function stgbUiSettings() {
    const ctx = stgbGetContext();
    if (!ctx.extensionSettings[STGB_PLUGIN_ID]) {
        ctx.extensionSettings[STGB_PLUGIN_ID] = { quickButton: false };
    }
    const settings = ctx.extensionSettings[STGB_PLUGIN_ID];
    // one-time migration: the quick top-bar icon used to default ON
    if (!settings.cloudIconMigrated) {
        settings.quickButton = false;
        settings.cloudIconMigrated = true;
        ctx.saveSettingsDebounced();
    }
    return settings;
}

function stgbSaveUiSettings() {
    stgbGetContext().saveSettingsDebounced();
}

async function stgbApi(path, options = {}) {
    const response = await fetch(STGB_API_BASE + path, {
        method: options.method || 'GET',
        headers: stgbGetContext().getRequestHeaders(),
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    let data = null;
    try {
        data = await response.json();
    } catch {
        // non-JSON response
    }
    if (!response.ok) {
        const err = new Error(data?.error || `HTTP ${response.status}`);
        Object.assign(err, data || {}); // surface needConfirm / remoteNewest etc.
        err.httpStatus = response.status;
        throw err;
    }
    return data;
}

function stgbSetText(selector, value) {
    const el = document.querySelector(selector);
    if (el) {
        el.textContent = value;
    }
}

function stgbSetBusy(button, busy, busyText) {
    if (!button) {
        return;
    }
    if (busy) {
        button.dataset.originalText = button.textContent;
        button.textContent = busyText;
        button.disabled = true;
    } else {
        button.textContent = button.dataset.originalText ?? button.textContent;
        button.disabled = false;
    }
}

function stgbShow(el, visible) {
    if (el) {
        el.style.display = visible ? '' : 'none';
    }
}

function stgbFormatTime(iso) {
    if (!iso) {
        return '（还没有备份过）';
    }
    return iso.slice(0, 19).replace('T', ' ');
}

// ---------- status / view switching ----------

async function stgbRefreshInfo() {
    try {
        const info = await stgbApi('/info');
        stgbShow(document.querySelector('#stgb_server_missing'), false);
        stgbShow(document.querySelector('#stgb_content'), true);
        stgbShow(document.querySelector('#stgb_setup'), !info.configured);
        stgbShow(document.querySelector('#stgb_main'), Boolean(info.configured));

        stgbSetText('#stgb_info_repo', info.repo || '-');
        stgbSetText('#stgb_info_last', stgbFormatTime(info.lastBackupAt));
        stgbSetText('#stgb_info_count', String(info.snapshotCount));
        stgbSetText('#stgb_info_git', info.gitVersion || '未检测到 git（在高级设置里设置 gitPath）');
        stgbSetText('#stgb_info_dir', info.dataDir || '-');
        const dot = document.querySelector('#stgb_status_dot');
        if (dot) {
            dot.className = 'stgb-status-dot ok';
        }
        stgbSetText('#stgb_status_text', info.busy ? '操作进行中…' : '云端备份已就绪');
        stgbShow(document.querySelector('#stgb_legacy_hint'), Boolean(info.legacyRepoDetected));

        if (info.configured) {
            await stgbLoadSettingsForm();
            await stgbRefreshSnapshots({ refresh: false, quiet: true });
        }
    } catch (err) {
        stgbShow(document.querySelector('#stgb_content'), false);
        stgbShow(document.querySelector('#stgb_server_missing'), true);
        const detail = document.querySelector('#stgb_server_missing_detail');
        if (detail) {
            // 500 means the server plugin IS installed but errored — don't
            // mislead the user into reinstalling.
            detail.textContent = err.httpStatus && err.httpStatus >= 500
                ? `服务端插件已安装，但请求出错（${err.message}）。请查看 SillyTavern 控制台日志。`
                : '本扩展需要配套的服务端插件才能工作：打开本扩展所在文件夹，双击 install.bat（Linux/mac 用 sh install.sh），然后重启 SillyTavern。';
        }
        stgbLog('server plugin not reachable:', err);
    }
}

// ---------- onboarding ----------

async function stgbProvision() {
    const token = document.querySelector('#stgb_token_input')?.value.trim();
    if (!token) {
        toastr.warning('请先生成并粘贴 Token');
        return;
    }
    const button = document.querySelector('#stgb_provision');
    stgbSetBusy(button, true, '配置中…');
    try {
        const result = await stgbApi('/provision', { method: 'POST', body: { token } });
        toastr.success(`已连接 ${result.platform === 'gitee' ? 'Gitee' : 'GitHub'}（${result.login}），仓库 ${result.repo} 已就绪`);
        document.querySelector('#stgb_token_input').value = '';
        if (result.remoteHasSnapshots) {
            stgbShow(document.querySelector('#stgb_choice'), true);
        } else {
            await stgbBackupNow({});
        }
        await stgbRefreshInfo();
    } catch (err) {
        toastr.error(`接入失败：${err.message}`);
    } finally {
        stgbSetBusy(button, false);
    }
}

async function stgbChoiceRestore() {
    stgbShow(document.querySelector('#stgb_choice'), false);
    await stgbRestore(null);
    await stgbRefreshInfo();
}

async function stgbChoiceOverwrite() {
    stgbShow(document.querySelector('#stgb_choice'), false);
    await stgbBackupNow({ force: true, confirmOverwrite: true });
    await stgbRefreshInfo();
}

function stgbChoiceCancel() {
    stgbShow(document.querySelector('#stgb_choice'), false);
    toastr.info('已跳过。之后可随时"立即备份"或从快照恢复');
    stgbRefreshInfo();
}

// ---------- backup ----------

async function stgbBackupNow(options = {}) {
    const button = document.querySelector('#stgb_backup');
    stgbSetBusy(button, true, '备份中…');
    try {
        let result;
        while (true) {
            try {
                result = await stgbApi('/backup', { method: 'POST', body: options });
                break;
            } catch (err) {
                if (err.needConfirm && !options.confirmOverwrite) {
                    const message = `云端已有比本机更新的备份（${err.remoteNewest || '来自其他设备'}）。\n\n直接备份将覆盖它，那份数据会丢失。确定要覆盖吗？`;
                    if (!confirm(message)) {
                        toastr.info('已取消备份，云端数据未改动');
                        return null;
                    }
                    options = { ...options, confirmOverwrite: true };
                    continue;
                }
                throw err;
            }
        }
        if (result?.skipped) {
            toastr.info(`数据无变化，已跳过（云端最新快照 ${result.snapshot}）`);
        } else if (result) {
            const mb = ((result.size || 0) / 1024 / 1024).toFixed(1);
            toastr.success(`备份完成：${result.snapshot}（${mb} MB，${result.files} 个文件）`);
        }
        await stgbRefreshInfo();
        return result;
    } catch (err) {
        toastr.error(`备份失败：${err.message}`);
        return null;
    } finally {
        stgbSetBusy(button, false);
    }
}

// ---------- snapshots / restore ----------

async function stgbRefreshSnapshots({ refresh = true, quiet = false } = {}) {
    const select = document.querySelector('#stgb_snapshots');
    if (!select) {
        return;
    }
    const refreshButton = document.querySelector('#stgb_refresh_snapshots');
    stgbSetBusy(refreshButton, true, '获取中…');
    try {
        const { snapshots } = await stgbApi(`/snapshots${refresh ? '?refresh=1' : ''}`);
        select.innerHTML = '';
        if (snapshots.length === 0) {
            select.append(new Option('（还没有任何快照）', ''));
            return;
        }
        for (const snapshot of snapshots) {
            const ts = snapshot.name.replace(/^snapshot-|\.zip$/g, '');
            const mb = snapshot.size != null ? ` ${(snapshot.size / 1024 / 1024).toFixed(1)}MB` : '';
            const source = snapshot.local ? '本机' : '云端';
            select.append(new Option(`${ts}（${source}${mb}）`, snapshot.name));
        }
    } catch (err) {
        if (!quiet) {
            toastr.error(`获取快照列表失败：${err.message}`);
        }
    } finally {
        stgbSetBusy(refreshButton, false);
    }
}

// Flush pending frontend settings before restoring: SillyTavern rewrites
// settings.json (whole file, from memory) ~1s after any UI change, which
// would otherwise clobber the just-restored file.
async function stgbFlushSettings() {
    const ctx = stgbGetContext();
    if (typeof ctx.saveSettings === 'function') {
        await ctx.saveSettings();
    } else {
        ctx.saveSettingsDebounced();
        await new Promise((resolve) => setTimeout(resolve, 1500));
    }
}

async function stgbRestore(snapshot) {
    const select = document.querySelector('#stgb_snapshots');
    const target = (snapshot === undefined || snapshot === null) ? (select?.value || '') : snapshot;
    if (!target) {
        toastr.warning('请先选择一个要恢复的快照');
        return;
    }
    if (!confirm(`确定要恢复到快照：\n${target}\n\n当前数据将被覆盖为该时点的备份！`)) {
        return;
    }
    if (!confirm('再次确认：这是覆盖性操作。恢复前会先把当前数据作为安全快照推送到云端，之后可随时恢复回来。继续吗？')) {
        return;
    }
    const button = document.querySelector('#stgb_restore');
    stgbSetBusy(button, true, '恢复中…');
    try {
        await stgbFlushSettings();
        const result = await stgbApi('/restore', { method: 'POST', body: { confirm: true, snapshot: target === '' ? null : target } });
        const safety = result.safetySnapshot ? `\n恢复前的数据已保存为安全快照：${result.safetySnapshot}` : '';
        alert(`恢复完成（${result.snapshot}）。${safety}\n\n请立即重启 SillyTavern，重启前不要做其他操作。恢复后的数据目录里不包含 secrets.json（API 密钥），如启用过该选项请重新填写。`);
        location.reload();
    } catch (err) {
        toastr.error(`恢复失败：${err.message}`);
    } finally {
        stgbSetBusy(button, false);
    }
}

// ---------- advanced settings ----------

async function stgbLoadSettingsForm() {
    try {
        const settings = await stgbApi('/settings');
        const map = {
            stgb_repo_url: settings.repoUrl || '',
            stgb_branch: settings.branch || 'main',
            stgb_keep_snapshots: settings.keepSnapshots ?? 10,
            stgb_auto_hours: settings.autoBackupHours || 0,
            stgb_git_path: settings.gitPath || '',
        };
        for (const [id, value] of Object.entries(map)) {
            const el = document.querySelector(`#${id}`);
            if (el) {
                el.value = value ?? '';
            }
        }
        const secrets = document.querySelector('#stgb_include_secrets');
        if (secrets) {
            secrets.checked = Boolean(settings.includeSecrets);
        }
    } catch (err) {
        stgbLog('failed to load settings:', err);
    }
}

async function stgbSaveSettingsForm() {
    const val = (id) => document.querySelector(`#${id}`)?.value ?? '';
    const body = {
        repoUrl: val('stgb_repo_url').trim(),
        branch: val('stgb_branch').trim() || 'main',
        keepSnapshots: Math.max(1, Number(val('stgb_keep_snapshots')) || 10),
        autoBackupHours: Math.max(0, Number(val('stgb_auto_hours')) || 0),
        gitPath: val('stgb_git_path').trim(),
        includeSecrets: document.querySelector('#stgb_include_secrets')?.checked ?? false,
    };
    await stgbApi('/settings', { method: 'POST', body });
    toastr.success('高级设置已保存');
}

async function stgbTestConnection() {
    const button = document.querySelector('#stgb_test');
    stgbSetBusy(button, true, '测试中…');
    try {
        await stgbSaveSettingsForm();
        const result = await stgbApi('/test', { method: 'POST' });
        toastr.success(`连接成功，云端包含 ${result.refs} 个引用`);
    } catch (err) {
        toastr.error(`连接失败：${err.message}`);
    } finally {
        stgbSetBusy(button, false);
    }
}

async function stgbCleanupLegacy() {
    if (!confirm('将删除旧版插件在数据目录创建的 .git 仓库和标记文件（不影响数据本身和云端备份）。继续吗？')) {
        return;
    }
    try {
        await stgbApi('/cleanup-legacy', { method: 'POST' });
        toastr.success('旧版仓库已清理');
        await stgbRefreshInfo();
    } catch (err) {
        toastr.error(`清理失败：${err.message}`);
    }
}

// ---------- quick top-bar button ----------

function stgbInjectQuickButton() {
    document.querySelector('#stgb_quick_btn')?.remove();
    const settings = stgbUiSettings();
    const hint = document.querySelector('#stgb_quick_hint');
    if (!settings.quickButton) {
        stgbShow(hint, false);
        return;
    }
    const anchor = document.querySelector('.drawer-icon.fa-cubes')?.closest('.drawer');
    if (!anchor) {
        stgbLog('extensions drawer not found; quick button skipped');
        stgbShow(hint, true);
        return;
    }
    stgbShow(hint, false);
    const button = document.createElement('div');
    button.id = 'stgb_quick_btn';
    button.className = 'drawer-icon fa-solid fa-cloud-arrow-up stgb-quick-button fa-fw';
    button.title = '云端立即备份';
    button.tabIndex = 0;
    button.addEventListener('click', () => stgbBackupNow({}));
    anchor.before(button);
}

// ---------- init ----------

jQuery(async function () {
    // 等待 SillyTavern context 就绪
    for (let i = 0; i < 100 && !(typeof SillyTavern !== 'undefined' && typeof SillyTavern.getContext === 'function'); i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    let html;
    try {
        const response = await fetch(STGB_BASE_URL + 'settings.html');
        if (!response.ok) {
            stgbLog('settings.html load failed:', response.status, STGB_BASE_URL + 'settings.html');
            return;
        }
        html = await response.text();
    } catch (err) {
        stgbLog('settings.html fetch failed:', err);
        return;
    }
    document.querySelector('#extensions_settings')?.insertAdjacentHTML('beforeend', html);

    document.querySelector('#stgb_provision')?.addEventListener('click', stgbProvision);
    document.querySelector('#stgb_choice_restore')?.addEventListener('click', stgbChoiceRestore);
    document.querySelector('#stgb_choice_overwrite')?.addEventListener('click', stgbChoiceOverwrite);
    document.querySelector('#stgb_choice_cancel')?.addEventListener('click', stgbChoiceCancel);
    document.querySelector('#stgb_backup')?.addEventListener('click', () => stgbBackupNow({}));
    document.querySelector('#stgb_refresh_snapshots')?.addEventListener('click', () => stgbRefreshSnapshots({ refresh: true }));
    document.querySelector('#stgb_restore')?.addEventListener('click', () => stgbRestore());
    document.querySelector('#stgb_save')?.addEventListener('click', () => stgbSaveSettingsForm().catch((err) => toastr.error(`保存失败：${err.message}`)));
    document.querySelector('#stgb_test')?.addEventListener('click', stgbTestConnection);
    document.querySelector('#stgb_cleanup_legacy')?.addEventListener('click', stgbCleanupLegacy);

    const quickToggle = document.querySelector('#stgb_quick_button_toggle');
    if (quickToggle) {
        quickToggle.checked = stgbUiSettings().quickButton;
        quickToggle.addEventListener('change', () => {
            stgbUiSettings().quickButton = quickToggle.checked;
            stgbSaveUiSettings();
            stgbInjectQuickButton();
        });
    }

    stgbInjectQuickButton();
    await stgbRefreshInfo();
    stgbLog('initialized');
});
