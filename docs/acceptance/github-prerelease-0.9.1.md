# 0.9.1 GitHub 预发布核验

日期：2026-10-07。产品：舷窗 Porthole。源码仓库：https://github.com/sky910140/porthole。

## 修复原因

[0.9.0 的远端构件验收](https://github.com/sky910140/porthole/actions/runs/37617909926)在本机服务启动后失败。Python 用实际文件路径计算配置身份，扩展原先只做字符串路径归一化；Windows `RUNNER~1` 等短名称或目录别名因此会产生不同身份，导致已经正常运行的服务被误判。

扩展现在统一使用基于 `fs.realpathSync.native()` 的路径解析，与服务端 `Path.resolve()` 对齐。配置身份、项目绑定、项目编号和编辑器文件边界使用同一规则；尚未保存的新文件解析已存在的父目录。仍验证令牌、协议、端口和连接模式，不绕过身份校验。新增三组目录别名回归用例，修复前失败，修复后通过；不同项目和通过链接越界的文件仍被拒绝。0.9.0 标签保留，修复使用新标签 0.9.1，不改写已上传历史。

## 验证范围

| 检查 | 实际结果 |
|---|---|
| 核心源码及 Ruff | Python 221 passed、2 skipped、3 warnings；覆盖率 84.99%，Ruff 通过 |
| 扩展 | 115 passed、0 failed；包括三组路径别名回归 |
| 架构边界 | 14 个文件通过 |
| Windows 凭据库 | 新冻结程序的临时凭据保存与清理通过 |
| 发布内容 | wheel、VSIX、运行 ZIP 检查通过，不含本机配置、令牌和日志 |
| 完整 VSIX | 实际 Windows 8.3 短路径下，提取包隔离安装、文本/CSV/XLSX 读取、预览、官方客户端联调、冻结程序重置和 VS Code 1.138.0 Extension Host 全部通过；运行 PATH 不含 Python 或 Node |
| 源码及文档检查 | 216 个文件，无当前代码旧品牌标识、断开的相对链接或本机业务路径 |
| 凭据检查 | vsce Secretlint 加 OpenAI/GitHub 令牌规则，共 751 个历史及当前文本对象，无发现；不等于完整安全审计 |

### GitHub Actions

[本轮 CI](https://github.com/sky910140/porthole/actions/runs/37621855069) 已全部通过，执行源码为 `544623de5080d222cb5a3cab365871196d62d6fd`。

| Windows 组合 | 单测、Ruff、架构边界 | Extension Host | 五组浏览器验证 | 完整安装包 |
|---|---|---|---|---|
| Python 3.11 + VS Code 1.137.0 | 通过 | 通过 | 通过 | 由 3.12 + 1.138.0 构建任务验收 |
| Python 3.11 + VS Code 1.138.0 | 通过 | 通过 | 通过 | 同上 |
| Python 3.12 + VS Code 1.137.0 | 通过 | 通过 | 通过 | 同上 |
| Python 3.12 + VS Code 1.138.0 | 通过 | 通过 | 通过 | wheel、VSIX 构建及内容检查、最终 VSIX 完整验收通过 |

四组远端 Python 测试均为 223 passed、3 warnings，无跳过；Python 3.11 覆盖率为 84.43%，3.12 为 84.99%。Node.js 使用 22，四组扩展测试均为 115 passed、0 failed。本机和远端结果分别记录，不以配置存在代替验证。0.9.0 的失败结果保留为问题证据，不计为本版通过项。

流水线仍有上游 Actions 使用 Node.js 20 的弃用注解；GitHub 当前切换至 Node.js 24 执行后通过。此项尚未通过升级 Actions 版本消除。

### 测试确定性修正

后续两项修改只涉及未打进安装包的测试：服务状态夹具按后端实际路径计算身份；编辑器过期测试用可控时钟分别验证过期前与精确过期边界，替代偶发失败的 60 毫秒实际等待。生产计时逻辑未改动。发布标签的 25 个生产文件与本轮 CI 源码逐项保持一致。

Extension Host 自动测试使用 `--use-inmemory-secretstorage` 隔离临时凭据。原生 SecretStorage 的快速更新与跨进程持久化仍待验收，不能从内存测试结果推断通过。

## 构件

| 文件 | 字节数 | SHA-256 |
|---|---:|---|
| `porthole_workspace-0.9.1-py3-none-any.whl` | 83,900 | `7deee832d11923f5df5e995d61effd8bfe5b0cadbcb1cd12727d8589a8f4f837` |
| `porthole-0.9.1.vsix` | 59,267,010 | `cdeb859785941d888c9d7ad0f9310375368a05cec5f210f624521a71909461f6` |
| `porthole-windows-x64.zip` | 30,597,822 | `0b753959fce3b8cf7c73daa950b7379370bb9d46b7e1222235c3fa43125ad5f3` |

GitHub 上传后的 7 个文件已逐项与本机大小和服务器 SHA-256 核对；VSIX 内的 25 个生产源码文件与 `v0.9.1` 标签一致。发布另附校验和、依赖及构件清单。

## 尚未完成

真实 ChatGPT 私有隧道账号认证与工具调用、真实网页修改完整闭环、干净 Windows 虚拟机、24 小时稳定性仍待验收。官方客户端联调使用本机控制面夹具。安装包未签名，未上架 VS Code 市场或公开 ChatGPT 插件目录。
