# 兼容性与验收状态

更新：2026-09-23。只有完成实际验证的组合标记为“通过”；CI 配置不等于远端流水线已运行。

| 组件 | 组合 | 状态 | 证据或限制 |
|---|---|---|---|
| 核心服务源码 | Windows、Python 3.12 | 通过 | Python 全套测试与真实 HTTP/MCP 测试 |
| 核心服务源码 | Windows、Python 3.11 | CI 待运行 | 已进入四组合矩阵，本机没有 3.11 运行结果 |
| 独立运行包 | Windows x64、无 Python/Node 的受限 PATH | 通过 | `docs/acceptance/runtime-package.md`；全新虚拟机仍待人工门禁 |
| VS Code 扩展逻辑 | Node 24 | 通过 | 单元测试与协议夹具 |
| VS Code Extension Host | VS Code 1.138.0 x64 | 通过 | 隔离用户数据、双根工作区集成测试 |
| VS Code Extension Host | VS Code 1.137.0 x64 | 通过 | 隔离 Extension Host，退出码 0 |
| 管理页 | Playwright Chromium | 通过 | 登录、项目策略、导航、演示、响应式和刷新隔离 |
| ChatGPT 网页读取 | 自托管 HTTPS + OAuth | 部分证据 | 已有项目列表/README 读取截图；候选版断连重试和当前账号仍待本人验收 |
| ChatGPT 网页修改闭环 | 自托管 HTTPS + OAuth | 未验收 | 本机 MCP→审阅→应用→查询自动化通过；公网与实际网页账号未跑通 |
| 升级、回退和卸载 | 干净 Windows 虚拟机 | 未验收 | 本机快照/恢复故障注入通过，虚拟机安装与 24 小时运行待做 |
| Claude 网页 | 自定义连接器 | 未验收 | 不列入首版承诺 |
| macOS、Linux | 源码或运行包 | 未验收 | 首版不承诺 |
| WSL、Remote SSH、Dev Containers | VS Code 远程工作区 | 不支持 | 首版范围外 |

外部平台能力和账号规则可能变化。一次历史读取不能证明当前账号、当前通道或所有用户持续可用。
