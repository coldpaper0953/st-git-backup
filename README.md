# ST Git Backup / Git 备份恢复

[English](#english) | [中文](#中文)

---

## 中文

一个 SillyTavern 扩展：把你的**全部用户数据**（聊天记录、角色卡、世界书、预设、主题、人设等）备份到任意 git 仓库（GitHub / Gitee / 自建），并支持一键从备份恢复。

- 备份 = `git add + commit + push`，恢复 = `git fetch + reset`，数据原样进仓库
- 支持 **SSH deploy key** 和 **HTTPS + Personal Access Token** 两种认证
- 默认**排除** `secrets.json`（你保存的 API 密钥）、聊天备份缓存、缩略图、向量缓存
- 可选自动备份（每小时 / 每 N 小时）
- 顶栏一键备份图标（可在设置里关闭）
- 兼容 Windows / Linux / Docker，单用户和多用户模式

### 工作原理

SillyTavern 的浏览器扩展无法执行 git，所以插件分两部分：

| 部分 | 位置 | 作用 |
|---|---|---|
| UI 扩展（`manifest.json` + `ui/`） | 通过扩展面板安装 | 设置界面、备份/恢复按钮 |
| 服务端插件（仓库根目录的 `index.js`） | install.bat 自动复制到 `SillyTavern/plugins/st-git-backup/` | 真正执行 git 命令 |

### 安装（两步，第二步全自动）

**第 1 步：安装 UI 扩展**

SillyTavern 顶部工具栏 → 拼图图标（Extensions）→ **Install extension** → 粘贴本仓库地址 → OK：

```
https://github.com/coldpaper0953/st-git-backup
```

**第 2 步：一键配置服务端（自动）**

打开刚装好的扩展目录（不同版本的 SillyTavern 放在两个位置之一）：

```
SillyTavern/public/scripts/extensions/third-party/st-git-backup/
或
SillyTavern/data/default-user/extensions/st-git-backup/
```

- **Windows**：双击 **`install.bat`**
- **Linux / macOS**：终端运行 `sh install.sh`

脚本会自动找到 SillyTavern 根目录：把服务端插件复制到 `SillyTavern/plugins/st-git-backup/` → 把 `config.yaml` 的 `enableServerPlugins` 改为 `true`。

**重启 SillyTavern**，启动日志出现 `[st-git-backup] server plugin initialized` 即成功。

> Docker 用户：容器内需有 git；`plugins/` 与 `data/` 需挂载出来才能持久化。可在容器内运行 `sh install.sh`。

<details>
<summary>手动安装（不想跑脚本时）</summary>

1. 把扩展目录整体复制为 `SillyTavern/plugins/st-git-backup/`（复制后该目录下应能直接看到 `index.js`）
2. 编辑 `SillyTavern/config.yaml`：`enableServerPlugins: true`
3. 重启 SillyTavern

</details>

### 配置备份仓库

打开 扩展面板 → **Git Backup & Restore**：

1. **仓库地址**：
   - SSH 方式（推荐）：`git@github.com:你的用户名/仓库名.git`
   - HTTPS 方式：`https://github.com/你的用户名/仓库名.git`
2. **分支**：一般填 `main`
3. **认证方式**：
   - **SSH 私钥**：填服务器上私钥文件的完整路径，例如
     `C:\Users\你\.ssh\id_ed25519` 或 `/home/user/.ssh/id_ed25519`
     （GitHub 需先在仓库 Settings → Deploy keys 添加对应公钥并勾选 *Allow write access*）
   - **HTTPS + PAT**：粘贴 GitHub Fine-grained token（需要该仓库的 *Contents: Read and write* 权限）
     token 只保存在服务端 `plugins/st-git-backup/settings.json`，**不会**进入备份仓库
4. 点 **保存设置** → **测试连接** → **立即备份**

### 恢复

扩展面板 → Git Backup & Restore → **获取提交历史** → 下拉选择要恢复的时间点 → **恢复到选中提交** → 按提示**重启 SillyTavern**。

⚠️ 恢复是覆盖操作：当前数据会被重置为所选时点的内容。恢复后重启前请勿操作 SillyTavern。

### 常见问题

- **提示 "服务端插件未安装"**：没做安装第 2 步，或没开 `enableServerPlugins`，或没重启
- **提示 git 不可用 / Failed to start git**：在服务端插件设置里没有 gitPath 选项时，把 git 加入 PATH，或在 `plugins/st-git-backup/settings.json` 中设置 `"gitPath": "git.exe 完整路径"`
- **私钥带 passphrase**：本插件不支持交互输入密码，请使用无 passphrase 的专用 deploy key
- **推送被拒 (non-fast-forward)**：仓库在别处更新过。先"获取提交历史"，确认无冲突后再恢复或手动合并
- **目录里已有别的 .git**：插件拒绝接管，需要你手动处理（删除或自行纳入）

### 数据安全说明

- 私钥 / token 仅存于服务端本地 `settings.json`，不会被提交或推送
- 默认排除的文件见 `index.js` 中 `buildGitignore()`；如需自定义可编辑数据目录下 `.gitignore` 中标记块之外的部分

---

## English

A SillyTavern extension that backs up **all of your user data** (chats, characters, world info, presets, themes, personas...) to any git repository (GitHub / Gitee / self-hosted), and restores it with one click.

- Backup = `git add + commit + push`, restore = `git fetch + reset`
- **SSH deploy key** or **HTTPS + PAT** auth
- `secrets.json` (your saved API keys), chat backup caches, thumbnails and vector caches are **excluded by default**
- Optional scheduled auto-backup
- Optional quick "backup now" icon in the top bar
- Works on Windows / Linux / Docker, single- and multi-user mode

### How it works

Browser extensions cannot run git, so the plugin has two parts:

| Part | Location | Purpose |
|---|---|---|
| UI extension (`manifest.json` + `ui/`) | installed via the extensions panel | settings UI, backup/restore buttons |
| Server plugin (repo-root `index.js`) | auto-copied by install.bat to `SillyTavern/plugins/st-git-backup/` | runs git |

### Install (two steps, step 2 is automated)

**Step 1 — UI extension**: Top bar → Extensions (puzzle icon) → **Install extension** → paste this repo URL.

**Step 2 — one-click server setup**: open the installed extension folder (either `SillyTavern/public/scripts/extensions/third-party/st-git-backup/` or `SillyTavern/data/default-user/extensions/st-git-backup/` depending on your SillyTavern version) and run **`install.bat`** (Windows) or `sh install.sh` (Linux/macOS). The script locates the SillyTavern root automatically, copies the server plugin to `SillyTavern/plugins/st-git-backup/` and sets `enableServerPlugins: true` in config.yaml. Then **restart SillyTavern** and look for `[st-git-backup] server plugin initialized` in the console.

### Configure

Extensions panel → **Git Backup & Restore**: fill in the repository URL (`git@github.com:user/repo.git` for SSH, or `https://...`), branch (`main`), and auth (SSH key path, or a fine-grained PAT with *Contents: Read and write*). Save → Test → Backup now.

For GitHub deploy keys: repo **Settings → Deploy keys → Add deploy key**, paste your **public** key, enable **Allow write access**.

### Restore

Extensions panel → **Get commit history** → pick a point → **Restore** → restart SillyTavern when prompted. Restore is destructive (hard reset to the selected commit).

### Troubleshooting

- *"服务端插件未安装"* → step 2 missing, `enableServerPlugins` not enabled, or server not restarted
- git not found → set `"gitPath"` in `plugins/st-git-backup/settings.json`
- Passphrase-protected keys are not supported; use a dedicated passphrase-less deploy key
- Non-fast-forward push rejected → fetch history and restore/merge first
- Existing foreign `.git` in the data directory → the plugin refuses to take over; resolve manually

### Security notes

- Keys/tokens live only in the server-side `plugins/st-git-backup/settings.json` (gitignored in this repo — never commit it)

---

## License

MIT — see [LICENSE](LICENSE)
