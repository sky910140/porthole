# 第三方软件说明

AI Zhagan 使用以下直接依赖；实际发行物还包含其传递依赖。构建发布包时应生成并随包保存完整的依赖与许可证清单。

| 依赖 | 用途 | 上游许可证 |
|---|---|---|
| FastMCP | MCP 服务 | Apache-2.0 |
| Uvicorn | 本地 ASGI 服务 | BSD-3-Clause |
| HTTPX | HTTP 客户端 | BSD-3-Clause |
| Pydantic | 配置与协议验证（传递使用） | MIT |
| Playwright | 管理页面端到端测试 | Apache-2.0 |
| VS Code Extension Test / VSCE | 扩展测试与打包 | MIT |

本文件不是完整法律意见。候选发布流水线必须以锁文件中的实际版本生成完整清单，并保留各依赖包内的许可文本。
