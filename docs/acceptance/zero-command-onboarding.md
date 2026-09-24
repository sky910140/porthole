# 0.3.0 免命令上手候选自测

日期：2026-09-24。环境：Windows 11 x64、Python 3.12.14、Node 24.14.1、VS Code 1.138.0。范围是本机候选包；尚未公开发布。

## 本轮实现

- 0.3.0 VSIX 内置 Windows x64 服务运行包。首页点击即可校验并安装；坏包、错误架构、错误协议、路径越界不能替换旧安装。
- VS Code 首页使用系统目录选择器授权项目。新目录生成独立项目标识，默认只读；已授权项目可切换、暂停、移除，也能单独打开“允许提出修改”和“允许本机应用”。
- 首页展示本机服务、公网通道、账号授权、真实工具调用四层状态。已过期调用不显示成当前已连接。共享范围按需显示可访问文件和排除统计，并标明扫描是否完整。
- 浏览器高级管理页及手动服务命令保留，旧“三步向导”命令转到首页。网页修改仍须在 VS Code 审阅后应用。

## 实际运行的自测

| 检查 | 结果 |
|---|---|
| Python `pytest -q` | 148 passed、2 skipped；3 条上游弃用警告 |
| `scripts/self-test.ps1` | Python 覆盖率 83.41%，达到 80% 门槛；ruff 与扩展检查通过 |
| `ruff check src tests scripts` | 通过 |
| 扩展 `npm run check` | 43 passed、0 failed（新增路径、策略、首页、离线安装和 Windows 重命名重试测试） |
| 扩展 `npm run test:integration` | VS Code 1.138.0 Extension Host 退出码 0；覆盖首页、目录加入、令牌不进入页面状态、既有编辑与审阅流程 |
| `npm run test:e2e` | 管理页浏览器 E2E 通过 |
| `node tests/e2e/changes.cjs` | 真实 MCP 建议→待审阅→本机应用→状态查询通过 |
| 扩展 `npm run package` | 完整构建运行包并生成 0.3.0 VSIX，292 个文件，包含 276 个运行包文件 |
| `scripts/verify-vsix.py` | 从最终 VSIX 解包，在隔离用户目录安装运行包；目标 PATH 仅有 Windows 系统目录，服务启动、配对、MCP 读取通过；提取后的扩展也通过真实 VS Code Extension Host 测试，最终包连续 3 次通过 |
| 候选内容与版本清单 | wheel、VSIX、运行 ZIP 敏感路径检查通过；`candidate-manifest.json` 版本一致 |

构建过程中发现 Windows PowerShell 5.1 的模块解析会导致 `Get-FileHash` 不可用，现已改用 .NET SHA-256，完整 `npm run package` 通过。VSIX 验证曾间歇遇到安装目录重命名 `EPERM`，已增加有限重试；另一次服务检查已通过，但测试清理目录时日志句柄尚未释放，验证脚本现会等待。修正后最终包连续 3 次通过。仍需在干净虚拟机观察安装稳定性。

## 尚未通过的发布门槛

- 尚无干净 Windows 虚拟机连续安装、升级失败回退、卸载记录；也没有代码签名或 Marketplace 发布。
- 本轮没有用实际 ChatGPT 账号完成公网 HTTPS、OAuth、真实读取和修改闭环。历史截图不能替代 0.3.0 的当前验收。
- 尚未进行 3–5 名初次使用者观察或 24 小时混合负载测试。
- VS Code 1.137.0 和 Python 3.11 已配置在 CI 矩阵，但 0.3.0 本轮未取得远端流水线结果。

因此 0.3.0 仍是未签名、未公开发布的本地候选版，不标记为 v1.0。
