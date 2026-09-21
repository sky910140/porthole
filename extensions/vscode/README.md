# AI Zhagan Context（VS Code）

该扩展把当前编辑器的文件内容、选区和诊断信息发送到本机 AI Zhagan 管理服务。它不代理任何模型或账号登录，也不会扫描或发送其他工作区文件。

## 安装

在 VS Code 中打开“扩展”视图，选择右上角 `…` → “从 VSIX 安装”，选取本目录生成的 `ai-zhagan-context-0.2.0.vsix`。

## 使用

首次使用建议运行 `AI Zhagan: 开始或继续三步向导`。向导只显示选择项目、连接、试着提问三步；取消后会从原步骤继续，多根工作区必须明确选择。

1. 已安装受管理运行包时，运行 `AI Zhagan: 启动并安全配对本机服务`。扩展从固定用户目录启动运行包，通过两分钟有效的一次性配对码取得凭据，并存入 VS Code SecretStorage。
2. 使用已有手动服务时，明确运行 `AI Zhagan: 配置连接`，再输入 Bearer token 并选择项目。扩展不会停止或升级手动服务。
3. 如需共享未保存内容，先在本机管理页为项目开启“共享未保存内容”，再打开绑定文件夹内的文件并运行 `AI Zhagan: 发布当前编辑上下文`。首次同步必须手动执行。
4. 如需自动同步，在当前工作区文件夹设置中启用 `aiZhagan.autoSync`。默认关闭，默认防抖 750 ms。
5. 运行 `AI Zhagan: 断开并清除上下文` 会删除服务端的当前编辑器会话上下文，并清除该文件夹的本地绑定和 token。

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

## 开发

```powershell
npm install
npm test
npm run test:integration
npm run check
npm run package
```

设置 `VSCODE_EXECUTABLE_PATH` 时，集成测试使用指定 VS Code；否则测试框架下载固定版本。每次运行使用独立临时用户数据和扩展目录。它启动真实 Extension Host 与本地 HTTP stub，验证配置、SecretStorage、未保存文本、选区、工作区边界和服务端清理；不会测试 ChatGPT 或 Claude 的登录流程。
