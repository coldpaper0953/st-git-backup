// ST Git Backup — SillyTavern UI extension
// Settings live in the extensions panel; a quick "backup now" icon can be
// injected into the top bar. All git work is done by the companion server
// plugin (/api/plugins/st-git-backup).

import { extension_settings, getContext, renderExtensionTemplateAsync } from '../../extensions.js';
import { saveSettingsDebounced } from '../../../script.js';

const PLUGIN_ID = 'st-git-backup';
const API_BASE = `/api/plugins/${PLUGIN_ID}`;
const TOKEN_MASK = '********';

const extensionName = (() => {
    const dir = new URL('.', import.meta.url).pathname.replace(/\/+$/, '').split('/').pop();
    return `third-party/${decodeURIComponent(dir || '')}`;
})();

const uiSettings = { ...{ quickButton: true }, ...(extension_settings[PLUGIN_ID] || {}) };

function saveUiSettings() {
    extension_settings[PLUGIN_ID] = uiSettings;
    saveSettingsDebounced();
}

function log(...args) {
    console.log('[st-git-backup]', ...args);
}

async function api(path, options = {}) {
    const ctx = getContext();
    const response = await fetch(API_BASE + path, {
        method: options.method || 'GET',
        headers: ctx.getRequestHeaders(),
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

function setText(selector, value) {
    const el = document.querySelector(selector);
    if (el) {
        el.textContent = value;
    }
}

function setBusy(button, busy, busyText) {
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

async function refreshInfo() {
    const missing = document.querySelector('#stgb_server_missing');
    const content = document.querySelector('#stgb_content');
    try {
        const info = await api('/info');
        if (missing) {
            missing.style.display = 'none';
        }
        if (content) {
            content.style.display = '';
        }
        setText('#stgb_info_git', info.gitVersion || '未检测到 git（在插件设置里指定 gitPath）');
        setText('#stgb_info_dir', info.dataDir || '-');
        setText('#stgb_info_last', info.lastCommit || '（仓库为空）');
        const dot = document.querySelector('#stgb_status_dot');
        if (dot) {
            dot.className = 'stgb-status-dot ' + (info.remoteConfigured ? 'ok' : 'idle');
        }
        setText('#stgb_status_text', info.remoteConfigured ? '已配置远端仓库' : '未配置远端仓库');
    } catch (err) {
        // server plugin not loaded -> show install instructions
        if (missing) {
            missing.style.display = '';
        }
        if (content) {
            content.style.display = 'none';
        }
        log('server plugin not reachable:', err);
    }
}

// ---------- settings form ----------

function applyAuthVisibility() {
    const authType = document.querySelector('#stgb_auth_type')?.value;
    document.querySelector('#stgb_ssh_row').style.display = authType === 'ssh' ? '' : 'none';
    document.querySelector('#stgb_token_row').style.display = authType === 'pat' ? '' : 'none';
}

async function loadSettingsForm() {
    try {
        const settings = await api('/settings');
        const map = {
            stgb_repo_url: settings.repoUrl,
            stgb_branch: settings.branch || 'main',
            stgb_auth_type: settings.authType || 'none',
            stgb_ssh_key: settings.sshKeyPath,
            stgb_token: settings.hasToken ? TOKEN_MASK : '',
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
        applyAuthVisibility();
    } catch (err) {
        log('failed to load settings:', err);
    }
}

async function saveSettingsForm() {
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
    const saved = await api('/settings', { method: 'POST', body });
    document.querySelector('#stgb_token').value = saved.hasToken ? TOKEN_MASK : '';
    toastr.success('设置已保存（保存在服务端插件目录）');
    await refreshInfo();
}

// ---------- actions ----------

async function testConnection() {
    const button = document.querySelector('#stgb_test');
    setBusy(button, true, '测试中…');
    try {
        await saveSettingsForm();
        const result = await api('/test');
        toastr.success(`连接成功，远端包含 ${result.refs} 个引用`);
    } catch (err) {
        toastr.error(`连接失败：${err.message}`);
    } finally {
        setBusy(button, false);
    }
}

async function backupNow(showToast = true) {
    const button = document.querySelector('#stgb_backup');
    setBusy(button, true, '备份中…');
    try {
        const message = document.querySelector('#stgb_commit_message')?.value.trim();
        const result = await api('/backup', { method: 'POST', body: { message: message || undefined } });
        if (!result.committed) {
            if (showToast) {
                toastr.info('没有变化，无需提交');
            }
        } else if (result.pushed) {
            toastr.success(`备份完成 ${result.commit.slice(0, 8)}，已推送到远端`);
        } else {
            toastr.success(`备份完成 ${result.commit.slice(0, 8)}（未配置远端，仅本地提交）`);
        }
        await refreshInfo();
        return result;
    } catch (err) {
        if (showToast) {
            toastr.error(`备份失败：${err.message}`);
        }
        throw err;
    } finally {
        setBusy(button, false);
    }
}

async function refreshLog() {
    const select = document.querySelector('#stgb_log');
    setBusy(document.querySelector('#stgb_refresh_log'), true, '获取中…');
    try {
        const { commits } = await api('/log?fetch=1');
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
        setBusy(document.querySelector('#stgb_refresh_log'), false);
    }
}

async function restoreSelected() {
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
        await api('/restore', { method: 'POST', body: { confirm: true, commit } });
        alert(`恢复完成（${commit.slice(0, 8)}）。\n\n请立即重启 SillyTavern，重启前不要做其他操作。`);
    } catch (err) {
        toastr.error(`恢复失败：${err.message}`);
    }
}

// ---------- quick top-bar button ----------

function injectQuickButton() {
    document.querySelector('#stgb_quick_btn')?.remove();
    if (!uiSettings.quickButton) {
        return;
    }
    const anchor = document.querySelector('.drawer-icon.fa-cubes')?.closest('.drawer');
    if (!anchor) {
        log('extensions drawer not found; quick button skipped');
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
            await backupNow(true);
        } catch {
            // toast already shown
        } finally {
            button.classList.remove('stgb-busy');
        }
    });
    anchor.before(button);
}

// ---------- init ----------

jQuery(async () => {
    const html = await renderExtensionTemplateAsync(extensionName, 'settings');
    document.querySelector('#extensions_settings')?.insertAdjacentHTML('beforeend', html);

    document.querySelector('#stgb_auth_type')?.addEventListener('change', applyAuthVisibility);
    document.querySelector('#stgb_save')?.addEventListener('click', () => {
        saveSettingsForm().catch((err) => toastr.error(`保存失败：${err.message}`));
    });
    document.querySelector('#stgb_test')?.addEventListener('click', testConnection);
    document.querySelector('#stgb_backup')?.addEventListener('click', () => backupNow(true).catch(() => { }));
    document.querySelector('#stgb_refresh_log')?.addEventListener('click', refreshLog);
    document.querySelector('#stgb_restore')?.addEventListener('click', restoreSelected);

    const quickToggle = document.querySelector('#stgb_quick_button_toggle');
    if (quickToggle) {
        quickToggle.checked = uiSettings.quickButton;
        quickToggle.addEventListener('change', () => {
            uiSettings.quickButton = quickToggle.checked;
            saveUiSettings();
            injectQuickButton();
        });
    }

    injectQuickButton();
    await refreshInfo();
    await loadSettingsForm();
    log('initialized');
});
