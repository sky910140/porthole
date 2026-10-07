# 舷窗 · Porthole

**让 AI 连接你授权的本机文件夹。**

舷窗是一个在本机运行的开源 MCP 工具。你选择要共享的文件夹，再让 ChatGPT 等支持 MCP 的客户端读取代码、资料和表格。需要修改文件时，AI 先提出建议，你在 VS Code 查看差异并明确应用。

[English](README.en.md) · [下载安装包](https://github.com/sky910140/porthole/releases/tag/v0.9.0) · [初学者操作手册](docs/beginner-manual.md) · [常见问题](docs/troubleshooting.md)

当前版本为 **0.9.0 预发布版**，采用 MIT 许可证，主要支持 **Windows x64 + VS Code**。干净 Windows 虚拟机安装、24 小时稳定性和真实 ChatGPT 私有隧道完整验收仍待完成；详见 [兼容性与验收范围](docs/compatibility.md)。安装包未上架扩展市场，也未进行代码签名。

## 新手从这里开始

使用安装包不需要安装 Python、Node.js，也不需要运行 PowerShell。

1. 从 [v0.9.0 下载页](https://github.com/sky910140/porthole/releases/tag/v0.9.0) 下载 **`porthole-0.9.0.vsix`**。
2. 打开 VS Code，在扩展面板选择 **… → 从 VSIX 安装**，安装后按提示重新加载。
3. 按 `Ctrl+Shift+P`，运行 **舷窗: 打开首页**，点击 **安装本机服务**。
4. 点击 **选择文件夹**，核对目录并授权，再点击 **预览可访问文件**。
5. 点击 **连接 ChatGPT（推荐）**，按向导填写 Tunnel ID 和运行 API Key，再在 ChatGPT 添加对应的隧道应用。
6. 在 ChatGPT 对话中选中该应用，发送向导提供的验证提示词。看到 **连接已验证** 后开始提问。

首次连接仍需在 OpenAI Platform 创建隧道与运行密钥，并具备相应的 Platform 和 ChatGPT 权限。推荐方式不需要域名或 GitHub OAuth App；工具不能替用户开通平台权限。各字段怎么填写见 [7 步操作手册](docs/beginner-manual.md)。

**日常使用：打开 VS Code → 选择已授权项目 → 在 ChatGPT 选中应用并提问。** 使用期间保持 VS Code、电脑和网络运行。本机服务或隧道启动成功，不等于 ChatGPT 已接通；以真实工具调用结果为准。

```mermaid
flowchart LR
    A[安装并打开舷窗] --> B[选择文件夹并授权]
    B --> C[预览共享范围]
    C --> D[连接 ChatGPT 并验证]
    D --> E[读取与分析文件]
    E --> F[可选：AI 提出修改]
    F --> G[VS Code 审阅并应用]
```

## 已有功能

| 功能 | 当前能力 |
|---|---|
| 项目管理 | 选择文件夹、切换项目、重命名、暂停和移除授权 |
| 文件读取 | 列目录、按行读取文本、固定字符串搜索，返回文件路径及范围 |
| 表格读取 | 有界读取 UTF-8 CSV 和 XLSX；不计算公式 |
| 分享范围预览 | 展示可访问文件、读取方式、排除原因及扫描是否完整 |
| Git 信息 | 在授权范围内查看状态和差异 |
| 编辑器上下文 | 经单独授权后分享当前文件、选区和诊断；未保存内容默认不共享 |
| 修改审阅 | AI 提交待审阅建议；用户在 VS Code 查看差异、应用或处理恢复 |
| 连接向导 | 保留设置草稿、自动检查、错误分类和真实调用验证 |
| 本机维护 | 服务启停、升级备份与回退、脱敏诊断、恢复初始状态 |

PDF、图片和旧版 XLS 暂不解析。Claude 网页、macOS、Linux 和 VS Code 远程工作区不在首版支持承诺中。

## 文件和权限由你控制

- 默认只读，只访问明确授权目录中符合策略的文件；未保存内容需要单独授权。
- AI 提出的修改先保存在本机，远程 MCP 不提供直接应用或任意执行命令的工具。
- 本机应用要求独立授权、差异审阅和文件状态检查；应用后还需运行项目自己的测试。
- 本机管理接口仅监听回环地址，与 MCP 接口隔离。自托管公网连接不要暴露管理端口 `8766`。
- 文件片段经 MCP 返回后由所选 AI 服务处理；这不是完全本地模型推理。
- 工具不启用自动遥测。主动导出的诊断包默认不含源码、密钥、账号身份和本机路径。

详见 [数据与隐私](docs/privacy.md)、[架构与信任边界](docs/architecture.md) 和 [安全报告](SECURITY.md)。

## 文档入口

| 你想做什么 | 阅读文档 |
|---|---|
| 第一次安装并连接 | [初学者操作手册](docs/beginner-manual.md) |
| 查看简版步骤 | [快速开始](docs/quickstart.md) |
| 连接失败或按钮异常 | [排查指南](docs/troubleshooting.md) |
| 清除旧授权、重新开始 | [恢复初始状态](extensions/vscode/RESET.md) |
| 了解 VS Code 设置与修改审阅 | [扩展说明](extensions/vscode/README.md) |
| 查看 MCP 工具和手动部署 | [工具与高级使用](docs/usage-reference.md) |
| 参与开发 | [贡献指南](CONTRIBUTING.md) |
| 构建安装包或发布版本 | [构建与发布](docs/releasing.md) |

完整文档、历史计划和验收记录见 [文档索引](docs/README.md)。

## 开发与自测

源码开发需要 Python 3.11+、Node.js 22+ 和 Git。以下命令用于开发者；普通用户安装 VSIX 即可。

```powershell
git clone https://github.com/sky910140/porthole.git
cd porthole
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-windows.lock
.\.venv\Scripts\python.exe -m pip install -e . --no-deps
npm ci
npm --prefix extensions/vscode ci
npx playwright install chromium --only-shell
powershell -NoProfile -File .\scripts\self-test.ps1
```

浏览器和真实 VS Code Extension Host 验证命令、源码结构见 [贡献指南](CONTRIBUTING.md)。测试使用隔离配置，不需要真实 AI 账号；本机测试不能代替外部账号的实际连接验收。

## 反馈与许可证

可复现的问题请提交 [Bug](https://github.com/sky910140/porthole/issues/new?template=bug.yml)，新需求请提交 [功能建议](https://github.com/sky910140/porthole/issues/new?template=feature.yml)。不要在公开 Issue 中粘贴密钥、账号授权响应或私人文件。

本项目采用 [MIT](LICENSE) 许可证。安装包内第三方组件遵循各自许可证，见 [第三方软件说明](THIRD_PARTY_NOTICES.md)。
