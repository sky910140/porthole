# 贡献指南

感谢参与 AI Zhagan。项目当前优先保证授权边界、结果可核验和故障可恢复。

## 本地开发

Windows 需要 Python 3.11+、Node.js 和 Git：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1
npm ci
Push-Location .\extensions\vscode
npm ci
Pop-Location
powershell -NoProfile -File .\scripts\self-test.ps1
```

核心测试不需要公网域名、GitHub OAuth 或真实 AI 账号。真实连接验收必须使用维护者自己的凭据，不能把令牌、日志或本地配置提交到仓库。

## 代码边界

- `server.py`、`admin.py` 是传输适配层；业务规则放在独立模块。
- 读取、搜索、Git 和修改功能必须共用项目访问策略。
- 项目文件只能由统一执行器写入；不得在扩展、管理页或 MCP 路由中另加写入捷径。
- 新行为先写会失败的测试，确认失败原因，再实现最小修改。
- 状态、错误码和接口字段从 Python 验证模型导出，不在多端手工维护副本。

提交前运行 Python、扩展和相关组合测试。PR 应说明用户可见行为、验证命令以及未覆盖的真实外部依赖。
