# 第三方软件说明

Porthole 使用以下直接依赖；实际发行物还包含其传递依赖。构建发布包时应生成并随包保存完整的依赖与许可证清单。

| 依赖 | 用途 | 上游许可证 |
|---|---|---|
| FastMCP | MCP 服务 | Apache-2.0 |
| Uvicorn | 本地 ASGI 服务 | BSD-3-Clause |
| HTTPX | HTTP 客户端 | BSD-3-Clause |
| openpyxl | 有界读取 XLSX | MIT |
| defusedxml | XML 解析安全防护 | PSFL |
| Pydantic | 配置与协议验证（传递使用） | MIT |
| Playwright | 管理页面端到端测试 | Apache-2.0 |
| VS Code Extension Test / VSCE | 扩展测试与打包 | MIT |
| [OpenAI tunnel-client](https://github.com/openai/tunnel-client) | 随 Windows VSIX 提供 v0.0.15 官方归档；固定 SHA-256 校验，安装时不联网 | Apache-2.0 |

归档 SHA-256 为 `3b53133a1e24d43f63088d843860cb1701a4c3ed6390de2e19f69089e43bddc1`。保留上游归档中的 LICENSE、NOTICE、许可证清单和 SPDX 元数据；额外许可文本位于 `third-party/tunnel-client/`，随 VSIX 的 `tunnel-bundle/` 提供。本项目不修改官方归档。

本文件不是完整法律意见。候选发布流水线必须以锁文件中的实际版本生成完整清单，并保留各依赖包内的许可文本。
