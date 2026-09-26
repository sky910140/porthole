# 0.3.1 网页 OAuth 迁移候选自测

日期：2026-09-26。此版本仍是本地候选，未公开发布。

## 已实现

- VS Code 首页提供“迁移旧网页连接”：选择旧 JSON 配置、输入原 GitHub OAuth App 的 Client ID / Client Secret、核对公网地址后确认。
- 迁移前验证旧加密 OAuth 记录和密钥；复制记录时把 FileTreeStore 集合索引中的旧绝对目录改为新目录。只迁移 OAuth 状态和网页身份设置，保留当前项目、访问权限与本机令牌。
- GitHub 凭据写入 VS Code SecretStorage；受管理服务启动时通过子进程环境变量传递。重新打开 VS Code 时，在已完成本机配对的前提下尝试恢复服务。
- 通过配置 ID、协议版本、端口和认证模式确认服务身份；端口被其他服务占用时中止，不控制其他进程。更新内置运行包前先停止精确匹配的旧实例。
- 迁移后验证本机实例和公网 OAuth 发现地址。失败时先停止新实例，再恢复本机配置、OAuth 目录和原服务；旧配置及旧 OAuth 记录始终保留。

## 本轮验证

| 检查 | 结果 |
| --- | --- |
| Python 核心测试与覆盖率 | 148 passed、2 skipped；83.41% |
| VS Code 扩展单测 | 50 passed，含密钥不匹配、覆盖保护、失败回滚、服务身份和首页入口 |
| Python/扩展静态检查 | 通过 |
| 隔离 OAuth 迁移互操作 | 使用真实 FastMCP 加密存储和 0.3.1 打包程序，导入后能按原密钥读取旧 client 记录，本机 OAuth 发现地址返回 200；旧记录及新本机令牌保持不变 |
| 0.3.1 VSIX | 打包完成；解包到隔离目录后，在目标 PATH 不含 Python/Node 的条件下启动并读取文件；VS Code Extension Host 通过 |
| 本机 VS Code 扩展 | 已从 0.3.0 安装为 0.3.1，`code --list-extensions --show-versions` 核对通过；未对用户现有 OAuth 记录执行迁移 |

## 尚需真实环境验收

未使用用户的原 GitHub Client Secret 操作现有 OAuth 记录，也未修改用户正在使用的本机配置。真实 ChatGPT 账号工具调用、必要时的重新授权、旧 0.3.0 运行中升级以及干净 Windows 虚拟机仍需验收。因此本地 OAuth 发现地址成功不能被解释为网页账号连接成功。
