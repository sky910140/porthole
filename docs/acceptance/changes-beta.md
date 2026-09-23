# 修改 Beta 诊断与故障验收

日期：2026-09-23  
范围：Task 10，Windows 11 x64、Python 3.12.14、VS Code 1.138.0

## 已验证

- 结构化事件只接受请求编号、修改编号、错误码、耗时和分层健康状态。日志大小、数量与保留期有界；导出默认去除项目路径，且可在导出前预览范围。测试中放入令牌、OAuth 返回和源文件内容，默认诊断包均不包含这些数据。
- 本地 MCP 实际提交修改后，管理页显示 `pending_review`，磁盘文件保持原状；本机就绪租约通过后应用，远程状态与管理页均显示应用结果。自动化没有把 `pending_review` 当成完成。
- 故障注入覆盖磁盘空间不足、SQLite 损坏、权限撤销、响应丢失，以及读队列拥塞下的状态查询。重连退避使用虚拟时钟验证 1、2、4、8、16、30 秒、抖动边界、暂停与认证失败停止重试。
- 真实 VS Code Extension Host 启动、注册命令并正常退出。故障自动化覆盖连接恢复状态机；睡眠、物理断网和服务进程被终止尚未在独立机器上逐项手动演练。

## 自测记录

```text
scripts/self-test.ps1
135 passed, 2 skipped; statement coverage 83.21%; Ruff and 31 extension unit tests passed

extensions/vscode: npm run test:integration
VS Code 1.138.0 Extension Host exited with code 0

node tests/e2e/changes.cjs
PASS: real MCP proposal -> pending page -> readiness apply -> remote and page status
```

## 发布阻断项

- 尚未用正式 VSIX、实际公网通道和 ChatGPT 账号执行从提交到网页查询的完整链路。当前端到端测试只证明本机真实 MCP、页面和文件执行器之间的一致性。
- 尚未在干净 Windows 虚拟机上完成故障演练和安装验证；没有 24 小时稳定性数据。
- 网页助手提交后必须再次调用 `get_change_status` 才能看到本机应用结果；自动化已验证状态语义，实际 ChatGPT 交互体验尚待记录。

因此当前产物仅可称为本地修改 Beta 候选，不标记 v0.3 公开发布通过。
