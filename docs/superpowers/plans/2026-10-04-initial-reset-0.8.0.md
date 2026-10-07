# 恢复初始状态 0.8.0 实施计划

> For agentic workers: use subagent-driven-development for the isolated core task, with controller integration and independent review. Track steps below.

**Goal:** 首页一次确认后清除本机授权和连接设置，保留安装、源码、业务文件、修改历史和恢复备份。

**Architecture:** 本机 CLI 执行有检查点的重置；运行中的服务先在回环管理接口停止接收新操作，再关闭。扩展负责暂停后台任务、停止隧道、关闭自启动、清理 VS Code 存储和显示结果。远程 MCP 不提供重置工具。

**Tech Stack:** Python 3.11+ / FastMCP / SQLite / Windows Credential Manager；Node / VS Code SecretStorage / Webview；pytest / node:test / Playwright / Extension Host。

**Spec:** 本次会话已批准的默认重置设计。

## Global Constraints

- 不重置用户真实服务，不操作外部账号；所有验收使用临时独立配置和端口。
- 清理范围仅是本工具拥有的状态和设置；源码、业务文件、安装运行包、changes 数据库和加密内容保留。
- 正在 applying、reverting、recovery_required 或升级时拒绝重置；旧访问令牌失效；中断可继续。
- 重置不静默升级当前运行包；运行旧服务且不支持安全重置时，给出“检查并安装附带版本”的具体入口。
- 重置结果不等于 ChatGPT/GitHub/OpenAI 的外部授权已撤销，完成页明确列出待处理入口。
- 重复点击串行且幂等；多窗口、重启和旧升级备份不能恢复已撤销授权。
- 不提交或覆盖此前尚未提交的迭代改动；本次不发布公开版本、不安装到日常 VS Code。

## Task 1: 本机重置事务与撤销边界

**Files:** 新建 `src/project_mcp/reset.py`、`tests/test_reset.py`；修改 `cli.py`、`server.py`、`admin.py`、`upgrade.py`、`protocol.py`，及对应测试。

**Interfaces:**
- CLI `reset-check --config <path>`：只读检查，成功输出 JSON `{ready:true, reset_id:null|string}`，忙碌/不兼容 exit 2。
- CLI `reset-local --config <path>`：继续/完成本机重置，成功输出 JSON `{reset_id:string, local_reset:true}`，失败 exit 2，不输出令牌。
- 固定配置相邻标记 `.reset-in-progress.json` 和回执 `.reset-receipt.json`，至少包含 `reset_id`；回执保留 `completed_at`。
- 管理接口 `POST /api/reset/prepare`：只在回环口、admin 认证下允许；检查活跃操作，写入检查点并阻止新操作。
- 协议 capabilities 添加 `initial_reset`，旧服务不支持时有明确错误。
- `initial_reset` 工具绝不出现在 MCP tools/list。

- [x] RED：测试空授权、新令牌、OAuth/配对/验证清理，文件和历史不变、凭据清理失败可续跑、重复重置、忙碌阻断、目录链接拒绝、旧快照不能恢复授权。
- [x] GREEN：实现本地事务、阶段记录、拥有进程的停机和服务启动保护。
- [x] 验证：`.venv/Scripts/python.exe -m pytest tests/test_reset.py tests/test_cli.py tests/test_upgrade.py tests/test_services.py -q`。

## Task 2: 扩展重置流程与新手界面

**Files:** 新建 `extensions/vscode/lib/initial-reset.js`、`test/initial-reset.test.js`；修改 `extension.js`、`lib/home.js`、`package.json` 与集成测试。

**Interfaces:** `InitialReset` 接收 `load/save/confirm/preflight/suspend/disableStartup/stopTunnel/resetCore/clearExtension/verify/notify`；`run()` 自动续跑且同一实例合并重复调用。状态 `{phase, step, issue, resetId, external}` 只包含脱敏字段。

- [x] RED：取消无副作用、重复点击、失败进度可恢复、不显示凭据、成功后再运行稳定。
- [x] GREEN：一次确认；逐步进度；“继续恢复”；清空本工具 SecretStorage/Memento/绑定/内存状态，监测配置相邻标记和回执，暂停自动恢复。
- [x] 界面：检查与修复添加“恢复初始状态”，成功首页回到选择项目；外部授权提供入口和说明，不能显示已撤销。
- [x] 验证：`node --test extensions/vscode/test/*.test.js`，真实 Webview 320/768/1440 宽度、取消/失败/继续/完成按钮测试。

## Task 3: 全链路验收与交付

**Files:** 新建 `tests/e2e/initial-reset.cjs`、`scripts/verify-reset.py`、`docs/acceptance/initial-reset-0.8.0.md`；更新版本、说明、快速开始和变更日志。

- [x] 独立服务验收：真实旧 MCP/admin 令牌失效；停机、重启、重复恢复、原文件 SHA-256 不变；恢复后空项目，未重新授权不可读。
- [x] 全套 Python / Node 检查，保持既有连接和修改流程通过。
- [x] 构建 wheel、Windows runtime、完整 VSIX，验收打包后 reset CLI 和 Extension Host。
- [x] 独立审查重置的失败恢复、进程/文件边界及旧备份授权隔离。
- [x] 写验收记录，给出安装包和具体入口；注明外部授权仍须自行断开。
