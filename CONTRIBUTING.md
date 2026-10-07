# 贡献指南

舷窗（Porthole）优先保证授权边界、结果可核验和故障可恢复。先从一个可复现问题或小范围改进开始；较大改动请在 Issue 中说明用户问题和接口影响。

## 本地开发

Windows 需要 Python 3.11+、Node.js 22+ 和 Git：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-windows.lock
.\.venv\Scripts\python.exe -m pip install -e . --no-deps
npm ci
npm --prefix extensions/vscode ci
npx playwright install chromium --only-shell
powershell -NoProfile -File .\scripts\self-test.ps1
```

完整本机组合验证：

```powershell
.\.venv\Scripts\python.exe scripts\check_architecture.py
npm --prefix extensions/vscode run test:integration
npm run test:e2e
node tests/e2e/changes.cjs
node tests/e2e/connection-wizard.cjs
node tests/e2e/initial-reset.cjs
node tests/e2e/scope-preview.cjs
```

测试使用隔离配置，不需要公网域名、GitHub OAuth 或真实 AI 账号。本机夹具不能代替真实连接验收；不要把实际密钥、日志和本机配置提交到仓库。

Extension Host 测试通过 VS Code 的 `--use-inmemory-secretstorage` 保存临时凭据，验证配对、断开与重置的调用逻辑，不验证 VS Code 原生凭据的跨进程持久化。冻结服务的 Windows 凭据存储另用 `scripts/verify-vault-runtime.py` 验证。

## 源码结构

| 目录 | 用途 |
|---|---|
| `src/project_mcp/` | 授权策略、读取、修改事务、服务与本机管理 |
| `src/project_mcp/static/` | 本机管理页面 |
| `extensions/vscode/` | VS Code 适配器、首页和连接向导 |
| `tests/`、`extensions/vscode/test/` | Python、扩展单测与浏览器验证 |
| `extensions/vscode/integration/` | 隔离的真实 Extension Host 验证 |
| `contracts/` | 版本化协议和生成契约 |
| `scripts/` | 开发、打包和构件检查 |
| `docs/` | 使用说明、架构、发布和历史验收 |

当前 Python 分发名为 `porthole-workspace`，CLI 为 `porthole`，扩展身份为 `sky910140.porthole`，设置和命令前缀为 `porthole`。业务模块保留 `project_mcp` 名称。

## 代码边界

- `server.py`、`admin.py` 是传输适配层；业务规则放在独立模块。
- 读取、搜索、Git 和修改必须共用项目访问策略。
- 项目文件只能由统一执行器写入，不在扩展、管理页或 MCP 路由中另加写入捷径。
- 新行为先写会失败的测试，确认原因，再实现最小修改。
- 状态、错误码和接口字段从 Python 验证模型导出，不在多端手工维护副本。

## 提交与反馈

1. Fork 仓库，在独立分支处理一个问题。
2. 改变用户行为时同步更新文档；只改文档时检查链接、版本和实际按钮名称。
3. 运行与改动相关的检查，记录命令和结果；跳过和未验收项不能记为通过。
4. 提交 PR，说明问题、改后行为、验证方法和必要限制。

安装包放在 GitHub Releases，不提交到源码仓库。`.local/`、`artifacts/`、`.venv/`、`.env*` 和 `config/local.json` 属于本机数据或构建产物。安全问题按 [安全策略](SECURITY.md) 私密报告，普通问题使用 Issue 模板。
