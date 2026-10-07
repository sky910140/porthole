# 兼容性与验收状态

更新：2026-10-07，舷窗 Porthole 0.9.0 预发布版。下表记录本次本机实际结果；远端结果以 [GitHub Actions](https://github.com/sky910140/porthole/actions) 为准。配置了流水线不等于已经通过。

| 组件或场景 | 验证组合 | 当前结果与限制 |
|---|---|---|
| 核心源码 | Windows、Python 3.12 | 221 passed、2 skipped、3 warnings；覆盖率 84.99%，Ruff 与 14 个文件的架构边界检查通过 |
| 核心源码 | Windows、Python 3.11 | 已配置 CI；本机未验证 |
| 扩展逻辑 | Node.js 24 | 112 passed、0 failed；打包工具要求 Node.js 22+ |
| 完整 VSIX | Windows x64、受限 PATH | 最终提取包隔离安装、配对、服务启停、文本/CSV/XLSX 读取、文件预览和冻结程序重置通过；不依赖目标 PATH 中的 Python 或 Node |
| VS Code Extension Host | VS Code 1.138.0 x64 | 最终 VSIX 提取包通过；覆盖项目隔离、首页状态、文件预览、重置与凭据清理 |
| VS Code Extension Host | VS Code 1.137.0 x64 | 已配置 CI；本机本轮未验证 |
| 浏览器与 Webview | Playwright Chromium | 管理页、修改建议到审阅应用、单页连接向导、初始状态恢复、文件范围预览五组通过 |
| 官方隧道客户端 | Windows x64、v0.0.15 | VSIX 内离线安装、SHA-256 校验、实际客户端与本机 MCP 联调、401/403/404 分类及断网重连通过；控制面使用本机夹具 |
| VS Code 凭据 | 原生 SecretStorage | 独立测试观察到快速设置更新期间的短暂旧值；跨进程持久化与此场景的稳定性待验收。Extension Host 自动测试使用内存凭据，不能代替原生持久化验收 |
| 真实 ChatGPT 私有隧道 | OpenAI Platform + ChatGPT | **待真实账号验收**；本机夹具不能证明平台认证、工作区权限与真实工具调用已跑通 |
| 自托管 HTTPS + OAuth | 实际网页账号 | **待本版本验收**；历史读取截图不代表当前版本持续可用 |
| 修改与恢复 | 本机 MCP、VS Code 与管理接口 | 隔离测试通过；远程 MCP 不提供直接批准、应用或重置工具；应用后需运行被修改项目的测试 |
| 安装、升级、卸载及长期运行 | 干净 Windows 虚拟机、24 小时 | **未验收** |
| macOS、Linux、Claude 网页 | 源码或客户端 | **未验收，不在首版支持承诺内** |
| WSL、Remote SSH、Dev Containers | VS Code 远程工作区 | **首版不支持** |

两项跳过涉及当前测试环境无法创建符号链接，未计入通过项。三条警告来自上游测试客户端和 HTTP 适配的弃用提示；没有把它们记为已解决。

0.9.0 改用了 `porthole` 命令、`sky910140.porthole` 扩展身份与 `%LOCALAPPDATA%\Porthole` 数据目录。早期内部版本没有自动迁移到新命名空间；不要把旧版本的运行结果或授权状态当作本版本结果。

本次命令、构件和发布范围见 [0.9.0 预发布核验](acceptance/github-prerelease-0.9.0.md)。历史记录见 [0.8.2](acceptance/scope-preview-hotfix-0.8.2.md)、[0.8.1](acceptance/reset-home-hotfix-0.8.1.md)、[0.8.0](acceptance/initial-reset-0.8.0.md)；保留原名称和原构件信息，以免改写历史证据。
