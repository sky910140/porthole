# 兼容性与验收状态

更新：2026-09-26（0.4.0 本机候选）。只有完成实际验证的组合标记为“通过”；CI 配置不等于远端流水线已运行。[上一轮 OAuth 迁移记录](acceptance/web-oauth-migration.md)。

| 组件 | 组合 | 状态 | 证据或限制 |
|---|---|---|---|
| 核心服务源码 | Windows、Python 3.12 | 通过 | 0.4.0 本机 155 passed、2 skipped，覆盖率约 83%；ruff 通过 |
| 核心服务源码 | Windows、Python 3.11 | CI 待运行 | 已进入四组合矩阵，本机没有 3.11 运行结果 |
| VSIX 内置运行包 | Windows x64、无 Python/Node 的受限 PATH | 本机通过 | 0.4.0 VSIX 解包、隔离安装、服务配对与 MCP 真实读取通过；全新虚拟机仍待验收 |
| VS Code 扩展逻辑 | Node 24 | 通过 | 0.4.0 扩展单测 64 passed，含首次设置、服务控制、诊断及升级回退 |
| 旧网页 OAuth 记录迁移 | FastMCP 加密文件树、0.4.0 打包程序 | 隔离环境通过 | 旧 client 记录导入后可解密，本机 OAuth 发现地址可用；真实 ChatGPT 账号仍待验收 |
| VS Code Extension Host | VS Code 1.138.0 x64 | 通过 | 隔离用户数据、多根工作区；源扩展及从最终 VSIX 提取的扩展均退出码 0 |
| VS Code Extension Host | VS Code 1.137.0 x64 | 0.3.0 待复测 | 0.2.0 曾在隔离 Extension Host 通过，本轮尚未重跑 |
| 管理页 | Playwright Chromium | 通过 | 登录、项目策略、导航、演示、响应式和刷新隔离 |
| ChatGPT 网页读取 | 自托管 HTTPS + OAuth | 部分证据 | 已有项目列表/README 读取截图；候选版断连重试和当前账号仍待本人验收 |
| ChatGPT 网页修改闭环 | 自托管 HTTPS + OAuth | 未验收 | 本机 MCP→审阅→应用→查询自动化通过；公网与实际网页账号未跑通 |
| 0.3.1 → 0.4.0 升级、回退 | 隔离本机用户目录 | 通过 | 旧 VSIX 安装、启动、快照、新 VSIX 安装、在线状态验证、手动回退至旧运行包并重新启动通过；未触碰用户现有服务 |
| 安装、升级、卸载 | 干净 Windows 虚拟机 | 未验收 | 虚拟机安装与 24 小时运行待做 |
| Claude 网页 | 自定义连接器 | 未验收 | 不列入首版承诺 |
| macOS、Linux | 源码或运行包 | 未验收 | 首版不承诺 |
| WSL、Remote SSH、Dev Containers | VS Code 远程工作区 | 不支持 | 首版范围外 |

外部平台能力和账号规则可能变化。一次历史读取不能证明当前账号、当前通道或所有用户持续可用。
