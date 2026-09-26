# AI Zhagan Context（VS Code）

该扩展提供 AI Zhagan 首页、本机运行包安装、项目授权、连接状态，以及明确授权后的编辑器上下文发布和修改审阅。它不代理任何模型或账号登录。

## 安装

在 VS Code 中打开“扩展”视图，选择右上角 `…` → “从 VSIX 安装”，选取本目录生成的 `ai-zhagan-context-0.4.0.vsix`。候选 VSIX 已内置 Windows x64 运行包。

## 使用

首次运行 `AI Zhagan: 打开首页`（旧命令 `AI Zhagan: 开始或继续三步向导` 也会打开首页）：

1. 点击“安装本机服务”。扩展验证内置清单后安装到固定用户目录；无需终端或复制运行包。
2. 点击“选择文件夹”，在系统目录选择器中选项目，检查完整路径后确认。扩展启动服务、使用两分钟有效的一次性配对码取凭据，并存入 VS Code SecretStorage。新项目默认仅查看已保存代码。选择新目录会产生独立授权，不继承旧项目的修改权限。
3. 首页可切换、暂停和移除已授权项目，也能预览可访问文件数量与排除统计。选择工作区外的目录会把它加入当前 VS Code 工作区。
4. 首页点击“设置网页连接”按步骤输入 HTTPS 根地址、GitHub 用户名和 OAuth App 凭据；系统验证公网 OAuth 地址并复制 MCP 地址。本机启动并不等于网页已连接，仍需在 ChatGPT 授权并执行真实工具调用。

首页“本机服务”区可启停服务，并选择是否在 Windows 登录时自动启动。启用开机启动时，OAuth 凭据保存在当前用户的系统凭据管理器；注册表只保存程序和配置路径。手动停止后，扩展不会自动重启，直到你主动点击“启动服务”。意外退出时，扩展在窗口重新获得焦点及定期检查时尝试恢复，连续失败三次后暂停自动恢复。

“检查连接”逐层定位故障；“尝试修复”只执行明确安全的本机步骤。诊断包默认不含源码、令牌、OAuth 响应、账号身份或本机路径。升级前会备份配置、运行包和修改数据库，安装失败会回退；成功升级后，仅当配置和修改记录未变化时可手动回退。回退后自动升级暂停，需主动点击“检查并安装附带版本”。

使用已有手动服务时，明确运行 `AI Zhagan: 配置连接`，输入 Bearer token 并选择项目。扩展不会停止或升级手动服务。

旧服务已有 ChatGPT 网页 OAuth 连接时，在首页点击“迁移旧网页连接”，选择旧配置 JSON 文件，输入原 GitHub OAuth App 的 Client ID 和 Client Secret，再确认原公网地址。扩展只导入 OAuth 状态和网页身份设置，保留当前项目、修改权限、本机令牌；失败会尝试恢复原配置。凭据仅保存在 VS Code SecretStorage。迁移后在 ChatGPT 发起真实工具调用验证，必要时重新授权。不能仅凭本机启动或 OAuth 发现地址成功就认定账号连接可用。

其他操作：

1. 如需共享未保存内容，先在本机管理页为项目开启“共享未保存内容”，再打开绑定文件夹内的文件并运行 `AI Zhagan: 发布当前编辑上下文`。首次同步必须手动执行。
2. 如需自动同步，在当前工作区文件夹设置中启用 `aiZhagan.autoSync`。默认关闭，默认防抖 750 ms。
3. 运行 `AI Zhagan: 断开并清除上下文` 会删除服务端的当前编辑器会话上下文，并清除该文件夹的本地绑定和 token。

## 连接 ChatGPT 网页

首页的“本机已就绪”只证明本机服务可用。网页还需要固定 HTTPS MCP 地址、GitHub OAuth 应用和允许账号。自托管时，把公网域名只转发到 MCP 端口 `127.0.0.1:8765`，不要公开本机管理端口 `8766`；OAuth 回调为 `https://你的域名/auth/callback`。首页向导会保存身份配置和 OAuth 凭据，但不会替用户创建域名、OAuth 应用或隧道。

在支持添加 MCP 连接的 ChatGPT 账号里添加 `https://你的域名/mcp`，本人完成 OAuth 登录，再从首页复制 `verify_connection` 提示词进行真实验证。[OpenAI 官方连接说明](https://developers.openai.com/plugins/deploy/connect-chatgpt)。配置步骤和诊断见仓库根目录 `README.md` 与 `docs/troubleshooting.md`。若缺少公网条件，可先使用本机功能或高级管理页的离线演示。

## 审阅和应用修改

项目在 VS Code 首页分别开启“允许提出修改”和“允许本机应用”后：

1. 网页提交建议并返回修改编号；此时本地文件没有改变。
2. 运行 `AI Zhagan: 查看修改建议`，输入编号，在 VS Code diff 中逐文件审阅。
3. 运行 `AI Zhagan: 应用已审阅修改`。相关窗口存在未保存内容、失联会话、过期检查或磁盘版本变化时，服务会阻止写入并说明下一步。
4. 可运行 `AI Zhagan: 拒绝修改建议`、`AI Zhagan: 查看修改恢复状态`；已应用且备份仍有效时可运行 `AI Zhagan: 撤销已应用修改`。

应用后状态明确显示“尚未运行测试”，扩展不会自行运行命令。差异预览内容不可编辑；需要调整建议时，应在网页基于当前文件创建新修改单。

`AI Zhagan: 打开 ChatGPT / Claude` 会先检查 VS Code 的“Browser: Open Integrated Browser”命令是否存在；存在时在集成浏览器中打开所选网站，否则只提示访问地址。网站登录由用户自行完成。扩展不保证第三方网站能在集成浏览器中完成登录。

## 数据边界

- 仅允许回环地址及 1024–65535 端口，拒绝远程主机、HTTPS 和特权端口。
- 只发布当前活动编辑器，且文件必须位于显式绑定的工作区文件夹内。
- `/api/status` 中所选项目的绝对 `root` 必须等于绑定工作区文件夹；每次发布前都会重新验证。
- 文本来自编辑器文档，因此包含尚未保存的修改；项目默认不允许此类上传，必须在本机管理页明确开启。
- 单文件 UTF-8 内容上限 1 MiB；诊断最多 100 条。
- 单条诊断的 severity 最多 20 字符、message 最多 4096 字符；选区文本最多 262144 字符，超出部分会截断。
- 路径相对于绑定文件夹，并统一为 POSIX `/` 分隔符。
- 选区来自当前编辑器；空选区发送 `null`。
- 服务端上下文 TTL 为 900 秒。过期后需再次发布；启用自动同步时，只有新的编辑或选区、诊断变化才会触发续传。
- 审阅会话每 2 秒上报一次，并在文档打开、关闭、编辑或保存时立即刷新。应用租约最多 5 秒且只能使用一次。
- 已登记的相关 VS Code 窗口全部参与检查。其他编辑器未保存的内存内容无法被协议观察；应用期间不要在外部编辑器同时修改同一文件。

## 服务 API

所有请求包含 `Authorization: Bearer <token>`。

- `GET /api/status`：返回协议版本、服务版本、能力、分层健康状态、`projects` 和 `sessions`。`projects[].root` 仅用于本机管理接口的工作区绑定检查。扩展接受同一主版本新增字段，拒绝缺字段或不兼容主版本。
- `PUT /api/context`：发送：

```json
{
  "project_id": "project-id",
  "session_id": "window-uuid",
  "path": "src/main.js",
  "version": 3,
  "text": "完整文件文本",
  "selection": { "start_line": 1, "end_line": 2, "text": "选中文本" },
  "diagnostics": [{ "line": 5, "severity": "warning", "message": "说明" }]
}
```

- `DELETE /api/context/{session_id}`：清除该工作区文件夹绑定会话发布的上下文。多根工作区的每个绑定使用独立 UUID。
- `PUT/DELETE /api/editor-readiness/{session_id}`：登记或清除审阅会话和已打开文档状态。
- `GET /api/changes/{change_id}`：获取本机审阅详情；`POST .../readiness` 签发短期租约；`POST .../apply` 只在租约和最终预检通过后应用。

## 开发

```powershell
npm install
npm test
npm run test:integration
npm run check
npm run package
```

设置 `VSCODE_EXECUTABLE_PATH` 时，集成测试使用指定 VS Code；否则测试框架下载固定版本。每次运行使用独立临时用户数据和扩展目录。它启动真实 Extension Host 与本地 HTTP stub，验证配置、SecretStorage、未保存文本、差异审阅、dirty 阻止、选区、工作区边界和服务端清理；不会测试 ChatGPT 或 Claude 的登录流程。
