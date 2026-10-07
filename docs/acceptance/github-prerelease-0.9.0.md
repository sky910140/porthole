# 0.9.0 GitHub 预发布核验

日期：2026-10-07。范围：公开舷窗 Porthole 当前源码、文档与 Windows x64 构件，版本标记为 **Pre-release**。本次核验使用隔离配置和临时用户目录，没有改动现有业务项目授权。

## 发布变更

- 统一产品名称、界面、命令、设置、CLI、可执行文件、扩展身份和凭据命名空间。
- CLI 为 `porthole`，扩展为 `sky910140.porthole`，默认数据目录为 `%LOCALAPPDATA%\Porthole`。
- 重整中英文 README、新手操作手册、文档索引、工具参考、贡献、安全与发布说明。
- 发布前审计后更新 PyJWT 到 2.15.0、`@vscode/vsce` 到 4.0.0；后者要求 Node.js 22+。

## 实际验证

| 检查 | 命令或方式 | 结果 |
|---|---|---|
| 核心及扩展 | `powershell -NoProfile -File scripts/self-test.ps1` | Python 221 passed、2 skipped、3 warnings，覆盖率 84.99%；Ruff 通过；扩展 112 passed、0 failed |
| 架构边界 | `python scripts/check_architecture.py` | 14 个文件通过 |
| 浏览器 | `node tests/e2e/{management,changes,connection-wizard,initial-reset,scope-preview}.cjs`，逐项执行 | 五组通过；覆盖失败重试、密钥不回显、文件清单、键盘及多种窗口宽度 |
| 完整安装包 | `python scripts/verify-vsix.py extensions/vscode/porthole-0.9.0.vsix` | 解包、校验、隔离安装、独立运行程序与 VS Code 1.138.0 Extension Host 通过 |
| 官方隧道程序 | 完整安装包验证中的实际客户端联调 | 离线安装、MCP、401/403/404 分类及断网同进程重连通过；控制面为本机夹具 |
| 重置 | 完整安装包验证中的冻结程序测试 | 停机、重启后无授权、旧管理/MCP 令牌拒绝、幂等、无远程重置工具、项目与恢复文件保留通过 |
| Windows 凭据存储 | `python scripts/verify-vault-runtime.py artifacts/runtime/dist/porthole/porthole.exe` | 临时身份的冻结程序凭据保存与清理通过 |
| Python 依赖 | `pip-audit` 检查 `requirements-windows.lock` 和 `requirements-build.txt` | 更新后未发现已知漏洞 |
| Node 依赖 | 根工程及扩展 `npm audit --audit-level=high --registry=https://registry.npmjs.org` | 更新后均为 0 vulnerabilities |
| 构件内容 | `python scripts/check_release_contents.py` 检查 wheel、VSIX、运行 ZIP | 三项通过；不含本机配置、令牌、日志和 OAuth 状态目录 |
| 版本与校验 | `python scripts/candidate_manifest.py` | 核心、扩展、运行包均为 0.9.0，运行清单与 ZIP 的大小及 SHA-256 一致 |

相对文档链接、当前代码旧品牌标识和待提交文件范围另外检查；历史验收记录保留原名称。密钥检查覆盖当前待提交文件及可达 Git 历史的文本对象，不把扫描结果解释为完整安全审计。

## 构件

| 文件 | 字节数 | SHA-256 |
|---|---:|---|
| `porthole_workspace-0.9.0-py3-none-any.whl` | 83,903 | `7d94056ed31b84fe7aad8732aa6ada6e4e01e56fcc30d644f0976902a451a32c` |
| `porthole-0.9.0.vsix` | 59,265,492 | `7c2d58394fb7d1e6a4d7c3fa6450c80e15bc7076c36bc2a9ff62792ee39c896d` |
| `porthole-windows-x64.zip` | 30,597,382 | `6ea026979ac17afd1e71ebced258b297821d746c82bc0cf0f4a3f4d2213d8f10` |

下载文件另附 `SHA256SUMS.txt`、发布清单和依赖清单。校验和不能替代代码签名；本版安装包未签名，未上架 VS Code 扩展市场或公开 ChatGPT 插件目录。

## 尚未完成

真实 ChatGPT 私有隧道账号认证与工具调用、真实网页修改完整闭环、干净 Windows 虚拟机验收、24 小时稳定性验收尚未完成。本机控制面夹具不能替代这些项目。远端 CI 结果请查看仓库 Actions，不由本机通过结果推断。
