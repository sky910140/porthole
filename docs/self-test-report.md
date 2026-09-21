# 本地首版自测报告

验收日期：2026-09-19。范围：Windows 本地服务、管理页面、VS Code 上下文扩展和安装产物。按用户要求，暂不进行公网域名、真实 ChatGPT / Claude 账号连接验收。

## 交付内容

- 独立 Python 服务：只读项目 MCP、项目登记、文件搜索与读取、Git 状态及 diff、内存中的编辑器上下文。
- 本机管理页面与 PowerShell 安装、启停、状态、令牌和自测脚本。
- VS Code 扩展：项目绑定、未保存内容/选区/诊断发布、可选自动同步、断开清理、官方网页入口。
- 其他 IDE 可复用的本地接口，见 [适配协议](adapter-api.md)。目前没有交付 JetBrains 等插件。

## 验证结果

| 层级 | 验证方式 | 结果 |
|---|---|---|
| Python 服务 | `scripts/self-test.ps1` 中的 pytest | 59 通过，1 跳过；语句覆盖率 87.26%，高于脚本要求的 80% |
| 代码检查 | Ruff | 通过 |
| 服务链路 | 真实子进程启停、HTTP MCP 客户端调用 | 通过 |
| 管理页面 | `npm run test:e2e`，Playwright Chromium | 通过 |
| 扩展逻辑 | `npm run check` | 6 项单元测试通过，语法检查通过 |
| VS Code 集成 | `npm run test:integration`，隔离的真实 Extension Host | 修复后连续两次通过，主任务独立复跑再次通过 |
| 安装产物 | Python wheel 构建、隔离安装及诊断；VSIX 打包 | 通过 |
| 依赖一致性 | `pip check` | 通过 |

环境：Windows、Python 3.12.14、VS Code 1.138.0。覆盖率包括 CLI 子进程；这不是分支覆盖率，也不代表所有异常场景均已覆盖。

唯一跳过项是缺少 Windows 符号链接创建权限。另一个实际创建 Windows junction 的越界隔离测试已通过。依赖库存在弃用警告；Extension Host 输出过宿主互斥量及内部通道警告，但测试断言通过、宿主退出码为 0。

## 核心场景

- 项目边界、路径穿越、敏感文件过滤、自定义状态目录和配置文件排除。
- Git 敏感文件重命名、窄路径查询和跨项目边界重命名不泄露内容。
- 本机管理和 MCP 使用不同令牌；匿名读取、错误令牌、非法 Origin 被拒绝；管理接口不出现在 MCP 端口。
- OAuth 缺少配置时拒绝启动；本人账号白名单和加密持久化通过本地测试。上游身份返回在账号白名单测试中使用模拟数据，未完成真实 GitHub 授权。
- 编辑器内容仅驻留内存，具有过期时间；不同项目、会话隔离，旧版本拒绝覆盖新版本。
- 浏览器验证错误/正确令牌、项目增删、脚本文本安全显示、刷新后令牌清除、桌面及窄屏布局。
- 扩展验证多根工作区、真实未保存缓冲区、选区、诊断行号、SecretStorage，以及焦点变化时的自动同步边界。
- 并发回归：旧 PUT 挂起时开始断开，再触发手动发布与自动同步，不产生新 PUT；释放旧请求后清除旧上下文，其他文件夹会话不受影响。断开、重配与停用期间阻止新发布。

扩展集成测试连接本地 HTTP stub；Python 服务则使用独立的真实 HTTP MCP 测试。尚未验证“正式安装扩展 → 实际 Python 服务 → 公网 → 官方网页账号”这一完整链路。

## 产物与复现

- 扩展：`extensions/vscode/ai-zhagan-context-0.1.0.vsix`
  - SHA-256：`6100412b587e3ef2577bf0948ef82268ed7a6ee09ac878a782bc76d27330c1cd`
- Python 包：`dist/project_mcp_assistant-0.1.0-py3-none-any.whl`
  - SHA-256（OAuth 文件名修复后重建）：`ca6a55539499b8c11df6549262d30973cd29d56198cd10a79abc590456a597c5`
- 页面截图：`artifacts/management-desktop.png`、`artifacts/management-mobile.png`。
- 覆盖率数据：`artifacts/python-coverage.json`。

按 [README](../README.md) 的“自测与打包”执行。扩展集成测试当前使用本机 VS Code 安装路径，其他机器需修改 `extensions/vscode/integration/run.js` 中的 `vscodeExecutablePath`。

本机服务已经初始化并启动，项目 ID 为 `ai-zhagan`，管理地址为 `http://127.0.0.1:8766`。令牌通过 `scripts/token.ps1` 在自己的终端查看；报告不记录任何令牌。扩展安装包已生成，未修改用户日常 VS Code 的扩展配置。

## 未验收部分

固定 HTTPS 域名、Cloudflare Tunnel、真实 GitHub OAuth、ChatGPT / Claude 登录与连接器、各账号的实际额度归属均待后续验收。当前结果不能解释为网页账号已经能读取本机项目。没有调用收费模型 API，也未发布公网服务。

本版提供只读开发辅助；自动修改文件、运行开发任务、其他 IDE 插件及 macOS/Linux 支持未包含在交付中。

## 2026-09-19 真实连接联调补充

公网 OAuth 发现端点已返回 200，匿名 MCP 初始化返回 401，公网管理接口返回 404。随后 ChatGPT 登录触发 `/authorize` 500：CIMD 的 URL 客户端标识被直接当作 Windows 文件名。

修复启用依赖库的文件名清理策略，保留加密存储和 OAuth 验证。新增 URL 标识读写、重启读取、碰撞隔离、删除和授权页面回归测试；修复前已复现同一 Windows OSError。授权测试只模拟远端客户端元数据，真实执行文件存储和 HTTP 授权流程。

本次全量 Python 测试 61 通过、1 跳过，语句覆盖率 87.27%。Ruff 导入排序问题修正后全量检查通过，认证相关 6 项测试再次通过。

运行中的服务须重新执行 `scripts/start-oauth.ps1`，输入原 GitHub Client ID / Secret 才会加载修复。真实 GitHub 授权及 ChatGPT 项目工具调用仍待用户完成；不能用本地回归通过代替账号验收。
