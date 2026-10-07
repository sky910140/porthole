# 构建、预发布与升级

当前版本：**0.9.0 预发布版**。公开源码不等于正式稳定版：干净 Windows 虚拟机、真实网页账号完整闭环和 24 小时运行仍待验收。当前发行物未签名，未上架 VS Code 市场或公开 ChatGPT 插件目录。

## 构建前验证

先按 [贡献指南](../CONTRIBUTING.md) 安装锁定依赖，执行单测、Ruff、架构边界、浏览器和真实 Extension Host 检查。核心、扩展与根 Node 工程的版本必须一致。

```powershell
powershell -NoProfile -File .\scripts\self-test.ps1
.\.venv\Scripts\python.exe scripts\check_architecture.py
npm --prefix extensions/vscode run test:integration
npm run test:e2e
node tests/e2e/changes.cjs
node tests/e2e/connection-wizard.cjs
node tests/e2e/initial-reset.cjs
node tests/e2e/scope-preview.cjs
```

## 构建完整安装包

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-build.txt
.\.venv\Scripts\python.exe -m pip wheel . --no-deps -w dist
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\package-extension.ps1
.\.venv\Scripts\python.exe scripts\verify-vsix.py extensions\vscode\porthole-0.9.0.vsix
.\.venv\Scripts\python.exe scripts\candidate_manifest.py dist\porthole_workspace-0.9.0-py3-none-any.whl extensions\vscode\porthole-0.9.0.vsix artifacts\runtime\porthole-windows-x64.zip
```

| 产物 | 用途 |
|---|---|
| `extensions/vscode/porthole-0.9.0.vsix` | 新手安装；含本机运行包和官方隧道客户端 |
| `artifacts/runtime/porthole-windows-x64.zip` | 开发者手动运行的独立 Windows 程序 |
| `dist/porthole_workspace-0.9.0-py3-none-any.whl` | 已有 Python 环境的开发者安装 |
| `dist/candidate-manifest.json` | 版本、大小、SHA-256 与验收目标 |

普通用户只下载 VSIX。仅执行 `package:vsix` 不会构建核心服务；完整发行物必须使用仓库根目录的 `scripts/package-extension.ps1`。

VSIX 附带固定版本 OpenAI `tunnel-client` v0.0.15 官方原始 ZIP，构建时校验 SHA-256。脚本优先使用 `artifacts/tunnel-cache/`；也可通过 `-TunnelArchive` 传入本机归档。只有构建阶段可能下载，用户安装后从 VSIX 离线安装。原始 LICENSE、NOTICE、SPDX 元数据与依赖许可报告必须保留，见 [第三方声明](../THIRD_PARTY_NOTICES.md)。

`verify-vsix.py` 从最终安装包解压并隔离安装，验证冻结程序、MCP 读取、文件预览、重置和真实 VS Code Extension Host。隧道检查使用本机控制面夹具，不代表真实 OpenAI 或 ChatGPT 账号已经验收。

## 检查发布内容

```powershell
.\.venv\Scripts\python.exe scripts\check_release_contents.py dist\porthole_workspace-0.9.0-py3-none-any.whl
.\.venv\Scripts\python.exe scripts\check_release_contents.py extensions\vscode\porthole-0.9.0.vsix
.\.venv\Scripts\python.exe scripts\check_release_contents.py artifacts\runtime\porthole-windows-x64.zip
```

这些检查拒绝状态目录、令牌、日志和 `.env` 文件；仍需检查待提交源码和 Git 历史中是否含真实凭据。构建产物不提交到源码仓库，而是作为 GitHub Release 附件提供。

首版发布使用 `v0.9.0` 标签并标记 **Pre-release**。附带 VSIX、运行 ZIP、wheel、`SHA256SUMS.txt`、构件清单与依赖清单。校验和证明下载文件与上传构件一致，不能代替代码签名。

## GitHub Actions

`.github/workflows/ci.yml` 为 Python 3.11/3.12 与 VS Code 1.137.0/1.138.0 配置 Windows 矩阵，覆盖单测、浏览器、Extension Host 和构件检查。`release-candidate.yml` 由维护者手动触发，验证后上传候选构件，不会自动创建公开 Release。

远端是否通过以 [Actions 实际结果](https://github.com/sky910140/porthole/actions) 为准。配置存在、本机通过和远端通过是不同状态，不相互替代。

## 本机升级与回退

VS Code 首页提供“检查并安装附带版本”和“回退上一备份”。升级前先快照配置、运行包、修改数据库和加密内容，验证路径、文件哈希和所属安装。安装或启动失败时尝试恢复旧包；成功升级后，只在配置和修改记录未变化时允许手动回退。

运行包目录必须是配置文件同级的 `runtime/current`。管理命令仅供本机，不通过 MCP 暴露。快照按敏感数据保存；升级进行中会阻止服务启动，直至验证完成或恢复。

当前版本的默认数据目录为 `%LOCALAPPDATA%\Porthole`，CLI 为 `porthole`。0.9.0 统一了扩展身份、配置和凭据命名空间，没有加入早期内部版本的自动迁移功能。

恢复初始状态与升级互斥，旧恢复代次的快照不能恢复已撤销授权。重置保留用户文件、修改历史与恢复备份，详见 [恢复说明](../extensions/vscode/RESET.md)。卸载或清理不能删除用户项目。
