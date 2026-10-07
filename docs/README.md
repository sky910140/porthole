# 舷窗文档索引

当前使用说明对应 **0.9.0 预发布版**。旧版本验收记录是历史证据，不代表当前版本或全部平台已经通过验证。

## 使用者

| 文档 | 内容 |
|---|---|
| [初学者操作手册](beginner-manual.md) | 下载、安装、各字段填写、连接验证、日常操作 |
| [快速开始](quickstart.md) | 简版步骤 |
| [排查指南](troubleshooting.md) | 按实际错误定位连接和本机问题 |
| [VS Code 扩展](../extensions/vscode/README.md) | 设置、编辑器上下文与修改审阅 |
| [恢复初始状态](../extensions/vscode/RESET.md) | 清理范围、失败续跑、外部连接处理 |
| [工具与高级使用](usage-reference.md) | MCP 工具、边界、手动服务与公网部署 |
| [数据与隐私](privacy.md) | 文件范围、凭据保存与诊断导出 |
| [兼容性](compatibility.md) | 支持范围、已验证组合和未完成验收 |

## 开发者与维护者

| 文档 | 内容 |
|---|---|
| [贡献指南](../CONTRIBUTING.md) | 环境、源码结构、自测与提交要求 |
| [架构](architecture.md) | MCP、本机管理、授权、修改和恢复边界 |
| [适配协议](adapter-api.md) | 其他编辑器接入约定 |
| [Windows 运行包](runtime.md) | 构建、安装路径和配对 |
| [构建与发布](releasing.md) | 构件、校验、预发布、升级与回退 |
| [更新记录](../CHANGELOG.md) | 版本变化 |
| [安全策略](../SECURITY.md) | 私密报告与修复范围 |
| [第三方声明](../THIRD_PARTY_NOTICES.md) | 上游组件和许可 |

架构决定保存在 `decisions/`，实施计划保存在 `plans/` 和 `superpowers/plans/`；它们用于保留设计背景，不是新手操作步骤。

## 验收记录

- [0.9.0 GitHub 预发布核验](acceptance/github-prerelease-0.9.0.md)：本次上传的检查和发布范围。
- [0.8.2 文件预览修复](acceptance/scope-preview-hotfix-0.8.2.md)。
- [0.8.1 首页状态修复](acceptance/reset-home-hotfix-0.8.1.md)。
- [0.8.0 初始状态恢复](acceptance/initial-reset-0.8.0.md)。
- [0.7.0 自动引导](acceptance/automated-onboarding-0.7.0.md)。
- [0.6.0 私有隧道](acceptance/private-tunnel-0.6.0.md)。
- [v1 发布评审](acceptance/v1.md)：较早的完整产品门禁检查；当前结果以兼容性表与本次核验为准。
