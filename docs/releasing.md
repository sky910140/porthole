# 候选构建与升级演练

当前版本：0.3.0。此文档描述**未公开发布**的 Windows 候选构建和本机升级保护。当前没有签名证书；干净虚拟机和真实网页账号验收仍是发布门禁。

## 候选构建

`.github/workflows/ci.yml` 在 Python 3.11/3.12 与 VS Code 1.137.0/1.138.0 四种组合上运行单元、真实 Extension Host 和本机端到端测试。`release-candidate.yml` 只允许手动触发，构建 wheel、VSIX、Windows 运行包，检查包内敏感文件，生成 SHA-256、大小、依赖清单与版本一致性清单，然后上传未发布构件；它不推送仓库、不创建 Release，也不发布市场扩展。若 CI 还未在 GitHub 实际运行，不把这些矩阵写成“通过”。

本机复核命令：

```powershell
./scripts/self-test.ps1
npm --prefix extensions/vscode run test:integration
npm run test:e2e
.venv/Scripts/python.exe -m pip wheel . --no-deps -w dist
./scripts/package-extension.ps1
.venv/Scripts/python.exe scripts/verify-vsix.py extensions/vscode/ai-zhagan-context-0.3.0.vsix
.venv/Scripts/python.exe scripts/candidate_manifest.py dist/ai_zhagan-0.3.0-py3-none-any.whl extensions/vscode/ai-zhagan-context-0.3.0.vsix artifacts/runtime/ai-zhagan-windows-x64.zip
```

候选清单在 `dist/candidate-manifest.json`。运行包清单和 ZIP 在 `artifacts/runtime/`。打包脚本只纳入源码和已声明的依赖；`check_release_contents.py` 对 wheel、VSIX 与运行 ZIP 拒绝本地令牌、日志、`.env` 和状态目录。第三方许可清单仍需发布前人工核对。

## 本机升级保护

先停止本工具服务，记录实际配置、状态和运行包目录。升级命令只接受本机终端，不经远程 MCP 暴露。为防止误操作用户项目，运行包目录必须是配置文件同级的 `runtime/current`。下面以默认状态目录为例：

```powershell
.venv/Scripts/project-assistant.exe stop --config "$env:LOCALAPPDATA/AI Zhagan/config.json"
.venv/Scripts/project-assistant.exe upgrade-prepare --config "$env:LOCALAPPDATA/AI Zhagan/config.json" --runtime-dir "$env:LOCALAPPDATA/AI Zhagan/runtime/current" --target-version 0.3
```

`upgrade-prepare` 打印快照编号。它拒绝 `applying`、`reverting`、`recovery_required`，用 SQLite Backup API 复制数据库，校验被引用及现存的加密 blob，并给快照文件记录 SHA-256。快照含配置、数据库、加密内容和旧运行包；请按敏感数据保管。准备后服务启动被 `upgrade-in-progress.json` 阻止，直到完成或恢复。

安装新运行包并执行离线检查后，使用快照编号完成；若安装或离线检查失败，使用恢复命令：

```powershell
.venv/Scripts/project-assistant.exe upgrade-complete --config "$env:LOCALAPPDATA/AI Zhagan/config.json" --runtime-dir "$env:LOCALAPPDATA/AI Zhagan/runtime/current" --snapshot-id SNAPSHOT_ID
.venv/Scripts/project-assistant.exe upgrade-restore --config "$env:LOCALAPPDATA/AI Zhagan/config.json" --runtime-dir "$env:LOCALAPPDATA/AI Zhagan/runtime/current" --snapshot-id SNAPSHOT_ID
```

两条命令二选一。`upgrade-complete` 执行显式的 0.2→0.3→1.0 配置迁移、配置验证、数据库完整性和运行包存在检查；这仍只是**离线检查**。完成后需要启动服务，再用 `doctor`、真实工具调用和本机修改审阅验证新版本。新修改的编号、revision 或状态一旦与快照不同，`upgrade-restore` 会拒绝静默回退，避免覆盖后续记录。较新数据库的 schema 版本会被旧读取器拒绝。卸载演练应只清理工具自己的运行包和状态目录，不能触碰项目源码目录。

目前升级自动化没有在干净 Windows 虚拟机执行完整的安装、升级、失败回退和卸载演练，因此不能据此宣布 v1.0 升级验收通过。
