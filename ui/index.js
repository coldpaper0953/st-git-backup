// ST Git Backup — SillyTavern UI extension
// Settings live in the extensions panel; a quick "backup now" icon can be
// injected into the top bar. All git work is done by the companion server
// plugin (/api/plugins/st-git-backup).
// Zero-import style: everything via global SillyTavern.getContext().

const STGB_PLUGIN_ID = 'st-git-backup';
const STGB_API_BASE = `/api/plugins/${STGB_PLUGIN_ID}`;
const STGB_TOKEN_MASK = '********';

// derive the extension folder name from our own <script> tag injected by SillyTavern
const STGB_FOLDER = (() => {
    const tag = document.querySelector('script[src*="/extensions/"][src$="/ui/index.js"][src*="st-git-backup"]');
    if (!tag) {
        return 'st-git-backup'; // fallback: default repo/folder name
    }
    const match = tag.src.match(/\/scripts\/extensions\/(.+)\/ui\/index\.js/);
    return match ? match[1] : 'third-party/st-git-backup';
})();
const STGB_BASE_URL = `/scripts/extensions/${STGB_FOLDER}`;
// folder segment used in /api references is the plain folder name
const STGB_NAME = STGB_FOLDER.includes('/') ? STGB_FOLDER.split('/').pop() : STGB_FOLDER;

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
    // one-time migration: the quick top-bar icon used to default ON; turn it
    // off once for users who never touched the toggle
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
        throw new Error(data?.error || `HTTP ${response.status}`);
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

// ---------- server plugin status ----------

async function stgbRefreshInfo() {
    const missing = document.querySelector('#stgb_server_missing');
    const content = document.querySelector('#stgb_content');
    try {
        const info = await stgbApi('/info');
        if (missing) {
            missing.style.display = 'none';
        }
        if (content) {
            content.style.display = '';
        }
        stgbSetText('#stgb_info_git', info.gitVersion || '未检测到 git（在服务端 settings.json 里设置 gitPath）');
        stgbSetText('#stgb_info_dir', info.dataDir || '-');
        stgbSetText('#stgb_info_last', info.lastCommit || '（仓库为空）');
        const dot = document.querySelector('#stgb_status_dot');
        if (dot) {
            dot.className = 'stgb-status-dot ' + (info.remoteConfigured ? 'ok' : 'idle');
        }
        stgbSetText('#stgb_status_text', info.remoteConfigured ? '已配置远端仓库' : '未配置远端仓库');
    } catch (err) {
        if (missing) {
            missing.style.display = '';
        }
        if (content) {
            content.style.display = 'none';
        }
        stgbLog('server plugin not reachable:', err);
    }
}

// ---------- settings form ----------

function stgbApplyAuthVisibility() {
    const authType = document.querySelector('#stgb_auth_type')?.value;
    document.querySelector('#stgb_ssh_row').style.display = authType === 'ssh' ? '' : 'none';
    document.querySelector('#stgb_token_row').style.display = authType === 'pat' ? '' : 'none';
}

async function stgbLoadSettingsForm() {
    try {
        const settings = await stgbApi('/settings');
        const map = {
            stgb_repo_url: settings.repoUrl,
            stgb_branch: settings.branch || 'main',
            stgb_auth_type: settings.authType || 'none',
            stgb_ssh_key: settings.sshKeyPath,
            stgb_token: settings.hasToken ? STGB_TOKEN_MASK : '',
            stgb_include_secrets: settings.includeSecrets,
            stgb_auto_hours: settings.autoBackupHours || 0,
        };
        for (const [id, value] of Object.entries(map)) {
            const el = document.querySelector(`#${id}`);
            if (!el) {
                continue;
            }
            if (el.type === 'checkbox') {
                el.checked = Boolean(value);
            } else {
                el.value = value ?? '';
            }
        }
        stgbApplyAuthVisibility();
    } catch (err) {
        stgbLog('failed to load settings:', err);
    }
}

async function stgbSaveSettingsForm() {
    const val = (id) => document.querySelector(`#${id}`)?.value ?? '';
    const body = {
        repoUrl: val('stgb_repo_url').trim(),
        branch: val('stgb_branch').trim() || 'main',
        authType: val('stgb_auth_type'),
        sshKeyPath: val('stgb_ssh_key').trim(),
        token: val('stgb_token'),
        includeSecrets: document.querySelector('#stgb_include_secrets')?.checked ?? false,
        autoBackupHours: Number(val('stgb_auto_hours')) || 0,
    };
    const saved = await stgbApi('/settings', { method: 'POST', body });
    document.querySelector('#stgb_token').value = saved.hasToken ? STGB_TOKEN_MASK : '';
    toastr.success('设置已保存（保存在服务端插件目录）');
    await stgbRefreshInfo();
}

// ---------- actions ----------

async function stgbTestConnection() {
    const button = document.querySelector('#stgb_test');
    stgbSetBusy(button, true, '测试中…');
    try {
        await stgbSaveSettingsForm();
        const result = await stgbApi('/test', { method: 'POST' });
        toastr.success(`连接成功，远端包含 ${result.refs} 个引用`);
    } catch (err) {
        toastr.error(`连接失败：${err.message}`);
    } finally {
        stgbSetBusy(button, false);
    }
}

async function stgbBackupNow(showToast = true) {
    const button = document.querySelector('#stgb_backup');
    stgbSetBusy(button, true, '备份中…');
    try {
        const message = document.querySelector('#stgb_commit_message')?.value.trim();
        const result = await stgbApi('/backup', { method: 'POST', body: { message: message || undefined } });
        if (!result.committed && result.pushed) {
            if (showToast) {
                toastr.info('本地无新变化，已确认远端同步');
            }
        } else if (!result.committed) {
            if (showToast) {
                toastr.info('没有变化，无需提交');
            }
        } else if (result.pushed) {
            toastr.success(`备份完成 ${result.commit.slice(0, 8)}，已推送到远端`);
        } else {
            toastr.success(`备份完成 ${result.commit.slice(0, 8)}（未配置远端，仅本地提交）`);
        }
        await stgbRefreshInfo();
        return result;
    } catch (err) {
        if (showToast) {
            toastr.error(`备份失败：${err.message}`);
        }
        throw err;
    } finally {
        stgbSetBusy(button, false);
    }
}

async function stgbRefreshLog() {
    const select = document.querySelector('#stgb_log');
    stgbSetBusy(document.querySelector('#stgb_refresh_log'), true, '获取中…');
    try {
        const { commits } = await stgbApi('/log?fetch=1');
        select.innerHTML = '';
        if (commits.length === 0) {
            select.append(new Option('（暂无提交）', ''));
            return;
        }
        for (const commit of commits) {
            const date = (commit.date || '').slice(0, 16).replace('T', ' ');
            select.append(new Option(`${date}  ${commit.subject}  (${commit.short})`, commit.hash));
        }
    } catch (err) {
        toastr.error(`获取提交历史失败：${err.message}`);
    } finally {
        stgbSetBusy(document.querySelector('#stgb_refresh_log'), false);
    }
}

async function stgbRestoreSelected() {
    const select = document.querySelector('#stgb_log');
    const commit = select.value;
    if (!commit) {
        toastr.warning('请先获取提交历史并选择一个恢复点');
        return;
    }
    const label = select.options[select.selectedIndex]?.text || commit;
    if (!confirm(`确定要恢复到：\n${label}\n\n当前数据将被覆盖为该时点的备份！\n恢复后需要重启 SillyTavern。`)) {
        return;
    }
    if (!confirm('再次确认：这是覆盖性操作，且不可撤销。继续吗？')) {
        return;
    }
    try {
        await stgbApi('/restore', { method: 'POST', body: { confirm: true, commit } });
        alert(`恢复完成（${commit.slice(0, 8)}）。\n\n请立即重启 SillyTavern，重启前不要做其他操作。`);
    } catch (err) {
        toastr.error(`恢复失败：${err.message}`);
    }
}

// ---------- quick top-bar button ----------

function stgbInjectQuickButton() {
    document.querySelector('#stgb_quick_btn')?.remove();
    if (!stgbUiSettings().quickButton) {
        return;
    }
    const anchor = document.querySelector('.drawer-icon.fa-cubes')?.closest('.drawer');
    if (!anchor) {
        stgbLog('extensions drawer not found; quick button skipped');
        return;
    }
    const button = document.createElement('div');
    button.id = 'stgb_quick_btn';
    button.className = 'drawer-icon fa-solid fa-cloud-arrow-up stgb-quick-button fa-fw';
    button.title = 'Git 立即备份';
    button.tabIndex = 0;
    button.addEventListener('click', async () => {
        button.classList.add('stgb-busy');
        try {
            await stgbBackupNow(true);
        } catch {
            // toast already shown
        } finally {
            button.classList.remove('stgb-busy');
        }
    });
    anchor.before(button);
}

// ---------- init ----------

jQuery(async function () {
    // 等待 SillyTavern context 就绪
    for (let i = 0; i < 100 && !(typeof SillyTavern !== 'undefined' && typeof SillyTavern.getContext === 'function'); i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const settingsResponse = await fetch(`${STGB_BASE_URL}/ui/settings.html`);
    if (!settingsResponse.ok) {
        stgbLog('settings.html load failed:', settingsResponse.status, `${STGB_BASE_URL}/ui/settings.html`);
        return;
    }
    const html = await settingsResponse.text();
    document.querySelector('#extensions_settings')?.insertAdjacentHTML('beforeend', html);

    document.querySelector('#stgb_auth_type')?.addEventListener('change', stgbApplyAuthVisibility);
    document.querySelector('#stgb_save')?.addEventListener('click', () => {
        stgbSaveSettingsForm().catch((err) => toastr.error(`保存失败：${err.message}`));
    });
    document.querySelector('#stgb_test')?.addEventListener('click', stgbTestConnection);
    document.querySelector('#stgb_backup')?.addEventListener('click', () => stgbBackupNow(true).catch(() => { }));
    document.querySelector('#stgb_refresh_log')?.addEventListener('click', stgbRefreshLog);
    document.querySelector('#stgb_restore')?.addEventListener('click', stgbRestoreSelected);

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
    await stgbLoadSettingsForm();
    stgbLog('initialized');
});
