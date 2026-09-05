# ST Git Backup 2.0 / 云端备份与恢复

[中文](#中文) | [English](#english)

---

## 中文

一个 SillyTavern 插件：把你**全部用户数据**（聊天记录、角色卡、世界书、预设、主题、人设等）自动打包成 zip 快照，备份到 GitHub 或 Gitee 私有仓库，并可一键恢复。

**2.0 版只需一步接入：粘贴一个 Token，其余全自动。** 不需要懂 git、不需要建仓库、不需要填仓库地址、不需要配置 SSH。

### 快速开始

1. **安装**：扩展面板安装本扩展（或手动放入 `data/<用户>/extensions/st-git-backup/`），双击扩展文件夹里的 `install.bat`（Linux/mac 用 `sh install.sh`），重启 SillyTavern。
2. **获取 Token**（唯一的手工步骤，扩展面板里有图文教程和直达链接）：
   - **GitHub**：fine-grained token 需要 `Contents: Read and write`（自动建仓还需 `Administration: Read and write`）；classic token 勾选 `repo` 即可
   - **Gitee**：私人令牌勾选 `projects`
3. **粘贴 Token → 点"开始使用"**。插件会自动：验证 Token → 创建私有仓库 `sillytavern-backup`（已存在则直接采用）→ 完成全部配置 → 立即执行首次备份。
4. 完成。之后随时点"立即备份"，或在高级设置里开启定时自动备份。

### 多设备使用

- **换新电脑**：安装插件 → 粘贴同一个 Token → 面板提示"云端已有备份"，选择**恢复云端备份到本机**即可。
- **两台电脑都用**：每次备份前插件会自动检查云端是否有另一台设备更新的备份，如有会弹窗提醒"直接覆盖将丢失那份数据"，确认后才覆盖。恢复前插件还会先把当前数据作为**安全快照**推送到云端，任何恢复都可以反悔。
- 自动备份建议只在一台主力设备开启，避免两台设备互相覆盖。

### 备份机制

- 每次备份把数据目录打包成 `snapshot-<时间戳>.zip` 推送到云端仓库
- 云端只保留最近 N 份快照（默认 10，高级设置可调），且历史每次重写、体积有硬上限，**不会无限增长**（Gitee 免费仓库约 500MB 限制也不怕）
- 默认排除：`secrets.json`（API 密钥）、缩略图、向量缓存、聊天备份缓存
- 数据无变化时自动跳过，不产生重复快照
- 恢复 = 取回快照 zip 自动解压覆盖本机数据，恢复后需重启 SillyTavern

### 工作原理

| 部分 | 位置 | 作用 |
|---|---|---|
| UI 扩展（`manifest.json` + `ui/`） | 通过扩展面板安装 | 引导界面、备份/恢复按钮 |
| 服务端插件（`index.js`） | install.bat 自动复制到 `SillyTavern/plugins/st-git-backup/` | 真正执行打包、git 推送/拉取、解压 |

- 备份存储目录：`SillyTavern/data/st-git-backup-store/`（本机快照缓存 + git 传输仓库），与用户数据目录完全分离
- Token 保存在 `plugins/st-git-backup/settings.json`（服务端本地），界面只显示掩码
- 兼容 Windows / Linux / Docker；git 可执行文件自动探测（含 SillyTavernLauncher 便携 git），特殊环境可在高级设置手动指定 gitPath

### 从 1.x 升级

旧版在数据目录里直接建 git 仓库。2.0 不再使用它；插件会在面板里提示"检测到旧版仓库"，点**一键清理**即可移除（不影响数据本身）。然后按快速开始重新接入（需要重新粘贴一个 Token）。

---

## English

A SillyTavern plugin that backs up **all your user data** (chats, characters, world info, presets, themes, personas…) as zip snapshots to a private GitHub/Gitee repo, with one-click restore.

### Quick start

1. **Install** the UI extension, run `install.bat` (`sh install.sh`) from the extension folder, restart SillyTavern.
2. **Create a token** — the only manual step (the panel has a step-by-step guide):
   - **GitHub**: fine-grained token needs `Contents: Read and write` (plus `Administration: Read and write` for auto repo creation); a classic token with `repo` scope also works
   - **Gitee**: personal access token with the `projects` scope
3. **Paste the token → click "Start"**. The plugin verifies it, creates the private repo `sillytavern-backup` (or adopts an existing one), configures everything and runs the first backup.
4. Done. Use "Backup now" anytime, or enable scheduled backups in advanced settings.

### Multi-device

- **New device**: install, paste the same token, choose "Restore cloud backup to this device" when prompted.
- **Two devices in parallel**: before every backup the plugin checks whether the cloud has a newer snapshot from another device and asks for confirmation before overwriting. Before every restore the current data is pushed as a **safety snapshot** first, so any restore is reversible.
- Enable scheduled backups on one primary device only.

### How it works

- Each backup packs the data directory into `snapshot-<timestamp>.zip` and pushes it to the repo.
- The remote keeps only the newest N snapshots (default 10) — history is rewritten on every push, so the repo size stays bounded (no problem with Gitee's ~500MB limit).
- Excluded by default: `secrets.json` (API keys), thumbnails, vector caches, chat backup caches.
- Restore = fetch snapshot → unzip → overwrite local data; restart SillyTavern afterwards.

### Upgrading from 1.x

1.x created a git repo directly inside the data directory. 2.0 no longer uses it — the panel will offer a one-click cleanup. Then re-onboard with a token.
