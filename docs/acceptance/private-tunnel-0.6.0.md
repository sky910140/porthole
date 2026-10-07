# 0.6.0 私有连接本机验收记录

日期：2026-10-02。范围：Windows x64 本机候选构建；未公开发布。

| 项目 | 结果 |
|---|---|
| Python 核心服务 | 169 passed、2 skipped；覆盖率 83.56%；ruff 通过 |
| VS Code 扩展逻辑 | 80 passed；包含固定哈希校验、旧配置切换回滚、进程就绪与停止、超时清理、首页与诊断状态 |
| VS Code Extension Host | 源码扩展隔离运行通过 |
| 0.6.0 VSIX | 打包成功；从最终 VSIX 解包后在无 Python/Node 的受限 PATH 中完成安装、配对和本机 MCP 读取 |

未完成的发布门禁：真实 OpenAI Platform Tunnel 创建与客户端连接、ChatGPT 开发者模式创建应用、`verify_connection` 网页调用、全新 Windows 虚拟机和长时间断网恢复测试。没有这些证据，不把私有连接称为已通过端到端验收。
