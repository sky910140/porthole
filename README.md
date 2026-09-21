# 本地项目助手

让官方 ChatGPT / Claude 对话按需读取本机项目。核心服务独立于 IDE；首个适配器为 VS Code。

当前提供项目目录、固定字符串搜索、分段读取、Git 状态和 diff、编辑器未保存内容/选区/诊断、只读 MCP、独立本地管理页面。没有模型 API 调用，也没有远程写文件或任意执行命令工具。

**当前验收范围是本地开发。** 真实 ChatGPT / Claude 登录、云端连接及额度路径尚未验证，需要固定 HTTPS 域名和本人 GitHub OAuth 配置。把本地服务运行起来，不代表两个网页账号已经接通。

## 快速开始（Windows）

需要 Python 3.11+；Git 功能还需要 Git。在本项目目录执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\token.ps1
```

最后一条命令在自己的终端显示本机管理令牌。打开 `http://127.0.0.1:8766`，粘贴令牌连接。不要把令牌贴到 AI 对话中。页面只在内存保存令牌，刷新后清除。

首次默认登记本项目，标识为 `current`。也可以在首次 setup 时传 `-ProjectPath 'D:\workspace\my-project' -ProjectId backend`；现有配置不会被覆盖。已经初始化的环境以管理页面显示的实际项目标识为准，可在页面添加或移除授权项目。

```powershell
.\scripts\status.ps1
.\scripts\stop.ps1
```

启停命令只控制本配置对应的服务，端口冲突会报错，不会杀死其他进程。服务默认只监听回环地址；关闭管理页面不会停止服务。

## VS Code 扩展

在“扩展 → … → 从 VSIX 安装”选择 `extensions/vscode/ai-zhagan-context-0.1.0.vsix`。

1. 打开已登记的项目目录。
2. 执行 `AI Zhagan: 配置连接`，输入本机管理令牌并选择对应项目。
3. 执行 `AI Zhagan: 发布当前编辑上下文`。令牌存入 VS Code SecretStorage。
4. 执行 `AI Zhagan: 打开 ChatGPT / Claude`，使用 VS Code 集成浏览器；第三方登录需实际验证。
5. 自动同步默认关闭，需要时在工作区启用 `aiZhagan.autoSync`。

磁盘工具读取已保存内容；`get_editor_context` 读取插件发布的内存快照。快照 15 分钟后失效。模型必须显式使用项目标识和会话标识，不能自动猜选另一窗口。

插件详细设置和测试见 [扩展说明](extensions/vscode/README.md)。其他 IDE 可以实现相同本地接口，详见 [适配协议](docs/adapter-api.md)。

## MCP 工具

| 工具 | 功能 |
|---|---|
| list_projects / workspace_info | 项目标识、Git 分支和提交信息 |
| list_files | 分页列出允许访问的文件 |
| search_code | 有界固定字符串搜索，附文件和行号 |
| read_file | 按行读取，附 SHA-256 和修改时间 |
| git_status / git_diff | 允许路径内的保存后变更 |
| list_editor_sessions | 已发布且未过期的编辑器会话 |
| get_editor_context | 指定会话的文本、选区及诊断 |

读取结果有大小、时间和数量限制，`truncated` 表示不完整，应缩小查询范围。非 UTF-8 文件和二进制文件不提供文本读取。代码片段通过 MCP 返回后会被对应 AI 服务处理，不是完全本地推理。

## 本地 MCP 客户端

MCP 地址为 `http://127.0.0.1:8765/mcp`，需要 **独立的 MCP 令牌**，不能使用管理令牌。仅在本机测试客户端中使用：

```powershell
.\scripts\token.ps1 -Kind mcp
```

本地令牌模式不配置给公网网页。服务没有匿名文件读取接口，也不会把管理接口放到 MCP 端口。

## 以后连接官方网页

1. 准备域名和 Cloudflare 命名 Tunnel，固定主机名只映射 `127.0.0.1:8765`；**不要映射管理端口 8766**。
2. 创建 GitHub OAuth App，回调 URL 为 `https://你的域名/auth/callback`。
3. 停止服务，编辑 `config/local.json`：`auth_mode` 设为 `github`，填写 HTTPS `public_url` 和仅含本人数字用户 ID 的 `github_user_ids`。
4. 在启动进程环境中设置 `PROJECT_MCP_GITHUB_CLIENT_ID`、`PROJECT_MCP_GITHUB_CLIENT_SECRET`；不要将它们提交到源码。OAuth 持久化使用加密存储。
5. 执行 `.venv\Scripts\project-assistant.exe doctor` 检查配置，再启动服务。
6. ChatGPT Developer mode 和 Claude 自定义连接器分别添加 `https://你的域名/mcp`，完成各自授权。

`public_url` 与本地令牌模式不能共用，配置会拒绝启动。缺失 OAuth 参数也会拒绝启动。Cloudflare 客户端沿用其官方配置，本项目不会在缺少域名和凭据时自动建立隧道。ChatGPT 要维持普通 Chat 路径；MCP 不会把网页订阅转成任意 IDE 的原生模型 API。

## 自测与打包

```powershell
.\scripts\self-test.ps1
npm ci
npx playwright install chromium --only-shell
npm run test:e2e
cd extensions\vscode
npm ci
npm run test:integration
npm run package
```

Python 测试覆盖真实文件/Git、越界与秘密过滤、认证、MCP 客户端、真实 HTTP 服务启停。浏览器测试验证登录错误反馈、项目管理、文本安全、页面刷新后的凭据清除和移动布局。扩展测试运行在隔离的真实 Extension Host 中，不改变日常 VS Code 配置。

本次结果与验收边界见 [自测报告](docs/self-test-report.md)。

依赖：Windows Python 锁文件为 `requirements-windows.lock`；两套 Node 工程均有 `package-lock.json`。不要在 macOS/Linux 上直接使用包含 Windows 专属依赖的锁文件；跨系统安装尚未验收。

源码尚未发布到插件市场或任何公网服务。JetBrains 等其他 IDE 插件、补丁应用及任务执行属于后续功能。
