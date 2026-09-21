# AI Zhagan 开源产品实施计划

修订：R2，2026-09-21。与 R2 产品说明配套；用户已要求优化文档，尚未授权执行产品实现。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task after the user approves the scope. Steps use checkbox (`- [ ]`) syntax for tracking. 本文是待确认的计划，当前不执行产品实现。

**Goal:** 将现有只读本地项目助手交付为可自托管、易诊断、支持本地审阅修改的开源工具产品。

**Architecture:** 保留 Python 核心服务与 VS Code 扩展。远程 MCP 负责读取和提交不可变修改单，仅本机管理接口可触发审阅后的写入；持久化状态、版本校验与恢复日志构成写入闭环。

**Tech Stack:** 现有 Python 3.11+、FastMCP、Starlette/Uvicorn、Pydantic、VS Code JavaScript 扩展、pytest、Node test runner、Playwright；新增标准库 SQLite。运行包冻结构建与 Windows 凭据保护在对应任务中验证，不能先假定打包成功。

**Spec:** [产品说明与设计](../specs/2026-09-21-ai-zhagan-product-design.md)。

## 本轮执行顺序优化

- 增加 **T00 风险验证**：先验证接入前提、干净机器安装和真实编辑器写入竞争，再投入完整功能开发。
- **T01 即启用 CI**，不等到发布阶段才自动回归；契约与生成结果漂移也进入检查。
- **T05 即做用户观察**：先让 3 名新用户走完上手流程，改善后再开发完整修改交互。
- 首页和向导只保留用户需要的操作；用户文案、后台状态和恢复动作建立明确映射。
- T06–T11 补齐操作级幂等、撤销中断恢复、资源预算、降级及数据库迁移，减少实现人员自行猜测。
- 技术可行与易用性分别验收；未解决自托管外部配置时，不以隐藏耗时的方式报告“零配置上手”。

## 全局约束

- 本计划当前状态为待确认；不启动实现、修改许可、发布仓库或部署服务。
- 首版支持 Windows 11 x64、VS Code Stable、本地文件夹、ChatGPT 网页；开发源码保持 Python 3.11+。
- WSL、Remote SSH、Dev Containers、多用户团队服务和多设备写入不在首版范围。
- 默认项目只读；允许提交修改不授予远程直接写入权限。
- 首版只创建／修改 UTF-8 文本；不删除、不重命名、不执行任意命令。
- 远程只暴露 MCP；管理与应用接口只在本机可用。
- 每份修改单最多 20 个文件；单文件最终内容不超过 1 MiB；整个提交 JSON 请求体不超过 2 MiB。
- 待审阅单默认 24 小时过期；修改内容和备份保留 7 天；幂等终态摘要保留 30 天；未解决恢复项不自动清理。
- 原文件、目标文件和修改单摘要均校验哈希；所有校验基于原始字节，不静默规范化换行。
- 不自动提交用户项目的 Git 修改，不改变用户项目分支；开发本工具的提交只包含本任务文件。
- 扩展与服务更新必须协商兼容性，写入与恢复期间不得升级。
- 不把本地自动化通过当成公网真实账号验收；测试结果、版本、环境分别记录。
- 对用户显示三步：选择项目 → 连接 ChatGPT → 试着问一个问题；后台保留可恢复的详细步骤。
- 导航固定为项目首页、待处理修改、设置与诊断；每种状态只有一个主要下一步。
- 修改状态增加修订号；暂时阻塞保留待审阅状态，基准内容变化才进入 conflict。
- API 字段和状态从单一验证模型导出；首版使用有界轮询，不同时建设事件总线与多种推送机制。
- 默认读取并发 4、排队 32；全服务文件修改事务并发 1；最多 100 份待审阅单、内容与备份配额 1 GiB。
- 不发布无法通过编辑器竞争验证的自动应用；降级为只读／补丁输出并记录限制。

## 1. 范围、依赖与里程碑

```mermaid
flowchart LR
    R[T00 接入、打包与写入风险验证] --> A[M0 范围、开源基线与 CI]
    A --> B[M1 三步上手、读取与诊断]
    B --> U[3 名新用户观察与调整]
    U --> C[v0.2 只读公开 Beta]
    C --> D[M2 修改协议与恢复引擎]
    D --> E[M3 VS Code 审阅和组合验收]
    E --> F[v0.3 修改公开 Beta]
    F --> G[M4 升级、试用与发布验收]
    G --> H[v1.0 自托管稳定版]
    H -.独立立项.-> I[托管连接 / 其他平台与助手]
```

| 里程碑 | 工作包 | 独立可交付结果 | 估算有效人日 |
|---|---|---|---|
| 风险验证 | T00 | 明确可行范围、失败条件及是否可开放写入 | 3–5 |
| M0 | T01 | 可复现基线、最小 CI 与开源准备 | 3–5 |
| M1 | T02–T05 | 三步上手、可诊断的 v0.2 和早期用户反馈 | 10–15 |
| M2–M3 | T06–T10 | 可恢复的修改闭环与 v0.3 | 17–25 |
| M4 | T11–T12 | 通过升级、试用与发布验收的 v1.0 | 7–11 |

R2 合计约 40–61 个有效工程人日，单名熟悉项目的工程师约 8–13 个工作周。相较 R1，显式计入前期实验、早期试用和数据迁移保护，避免以遗漏工作压低估算。该估算用于范围讨论，不是交付承诺；不含账号开通、域名准备、商店审核、证书采购、托管平台建设和大规模跨平台适配。T00 与 M1 完成后各更新一次估算。

各任务按依赖顺序推进；只有阶段验收通过，才对外标记相应能力。上一轮检查当前工作区未识别为 Git 仓库，T00 开始前应重新确认位置，T01 建立正式基线。

## 2. 文件职责规划

新增文件均为计划路径，此次只创建说明和计划文档。

| 文件／目录 | 职责 |
|---|---|
| `src/project_mcp/protocol.py` | 版本、能力、稳定错误码与响应类型 |
| `contracts/generated/`、`scripts/export-contracts.py` | 从验证模型导出的 JSON Schema 与跨语言夹具，不手工编辑生成结果 |
| `src/project_mcp/runtime_limits.py` | 有界队列、并发、重试分类与预算 |
| `src/project_mcp/health.py` | 分层健康、验证挑战、最近调用证据 |
| `src/project_mcp/policy.py` | 项目能力与读写访问策略 |
| `src/project_mcp/config.py` | 保留现有设置，增加版本迁移和能力配置 |
| `src/project_mcp/workspace.py` | 保留读取入口；增加精确截断原因、有界批量读取 |
| `src/project_mcp/pairing.py` | 同用户本机配对及凭据引导 |
| `src/project_mcp/changes/models.py` | 修改请求、状态、结果契约 |
| `src/project_mcp/changes/store.py` | SQLite 修改单、幂等约束、状态转换与保留期 |
| `src/project_mcp/changes/content.py` | 待写内容及原始备份的受保护存储 |
| `src/project_mcp/changes/service.py` | 提交、查询、授权检查与本机应用协调 |
| `src/project_mcp/changes/executor.py` | 路径预检、写前日志、逐文件应用 |
| `src/project_mcp/changes/recovery.py` | 重启核验、恢复和有条件撤销 |
| `src/project_mcp/editor_readiness.py` | 编辑器审阅租约与当前文档就绪状态 |
| `src/project_mcp/diagnostics.py` | 活动日志、轮转、脱敏诊断导出 |
| `extensions/vscode/lib/service-manager.js` | 运行包安装、校验、启动和升级 |
| `extensions/vscode/lib/onboarding.js` | 项目授权和连接向导 |
| `extensions/vscode/lib/view-state.js` | 后台状态到用户文案、主操作的纯函数映射 |
| `extensions/vscode/lib/changes.js` | 修改单列表、差异视图、应用和拒绝 |
| `extensions/vscode/lib/readiness.js` | 跨已登记会话的文档就绪检查 |
| `src/project_mcp/static/*` | 保留管理页面，同步状态与诊断；首版不提供应用按钮 |
| `scripts/build-runtime.ps1` | 构建 Windows x64 服务运行包 |
| `tests/test_changes_*.py` | 状态、写入、恢复和协议行为测试 |
| `tests/e2e/changes.cjs` | 跨服务／界面的修改状态验收 |
| `docs/acceptance/` | 安装、平台、真实网页调用和故障验收证据 |
| `.github/workflows/` | 干净环境测试、构建与候选发布产物 |
| `tests/test_architecture.py`、`tests/test_protocol_contract.py` | 模块依赖方向与生成契约一致性检查 |
| `docs/decisions/` | 写入路径、契约、迁移与支持边界的简短决策记录 |

不把所有新功能堆进 `server.py`、`admin.py` 或 `extension.js`；这些文件保留接口装配职责。

## 3. 公共接口草案

以下契约是任务之间的约束，代码块以 TypedDict 表达字段语义；正式实现使用现有 Pydantic 验证模型并导出 Schema，扩展不另建手写副本。接口变更须同时更新产品说明、生成契约和消费方测试。

### 状态与错误

```python
# src/project_mcp/protocol.py 中拟新增的公共类型
from typing import Literal, TypedDict

CheckState = Literal["unknown", "checking", "ok", "failed", "expired"]

class HealthCheck(TypedDict):
    state: CheckState
    checked_at: str | None  # UTC ISO-8601
    error_code: str | None
    retryable: bool

class ErrorDetail(TypedDict):
    code: str
    message: str
    retryable: bool
    request_id: str
```

错误码至少覆盖：`AUTH_REQUIRED`、`PROJECT_FORBIDDEN`、`PATH_FORBIDDEN`、`RATE_LIMITED`、`SCAN_LIMIT`、`FILE_TOO_LARGE`、`FILE_CHANGED`、`EDITOR_DIRTY`、`EDITOR_UNAVAILABLE`、`LEASE_EXPIRED`、`IDEMPOTENCY_CONFLICT`、`RECOVERY_REQUIRED`、`VERSION_INCOMPATIBLE`、`QUOTA_EXCEEDED`、`STORAGE_UNAVAILABLE`、`RECORD_UNAVAILABLE`。

读取接口向后兼容，新增 `source`、`has_more`、`truncation_reason`；保留原 `truncated`。继续分页使用服务端返回的 `next_offset`；扫描上限耗尽时返回空的 `next_offset` 和缩小目录的提示，不能误导继续全局翻页。

### 修改单

```python
# src/project_mcp/changes/models.py 中拟新增的公共类型
from typing import Literal, TypedDict

class FileChange(TypedDict):
    path: str
    operation: Literal["create", "modify"]
    base_sha256: str | None
    content_utf8: str

class ChangeRequest(TypedDict):
    project_id: str
    request_id: str
    summary: str
    files: list[FileChange]

ChangeState = Literal[
    "pending_review", "rejected", "expired", "conflict", "applying",
    "applied", "rolled_back", "recovery_required", "reverting", "reverted"
]

class ChangeResult(TypedDict):
    change_id: str
    state: ChangeState
    manifest_sha256: str
    revision: int
    blocked_reason: str | None
    error_code: str | None
```

`actor_id` 必须从服务器认证上下文获得，不能相信工具参数提供的身份。去重唯一键为 `(actor_id, project_id, request_id)`。

本机 `POST /api/changes/{id}/apply` 请求体为 `operation_id`、`expected_revision`、`manifest_sha256`、`review_session_id`、`readiness_lease_id`。服务核验租约归属、期限、文件列表、当前权限和版本；不能以客户端一个 `approved: true` 字段替代授权。拒绝、恢复和撤销也使用操作编号和预期修订号。

同操作编号的合法重试先返回已保存的操作结果，不因租约过期再次执行；同编号不同参数返回冲突。新应用首次执行才验证当前租约。预检被阻塞也持久化该次结果，用户明确重试时使用新操作编号和新租约。30 天保留期外返回记录不可用，不自动重放未知操作。

用户界面状态采用纯映射：`deriveViewState({health, projectMode, changeState, blockedReason}) -> {label, primaryAction, detail}`。错误恢复建议由错误码映射产生，不能让远程传入任意可执行修复命令。

## 4. 任务清单

每个任务遵循：先写能复现所需行为的测试，确认失败原因，再实现并运行针对性验证，最后评审与提交。命令中的 Python 路径沿用当前工作区虚拟环境；干净 CI 使用对应已安装解释器。

### T00：先验证高风险路径和首次使用假设

**依赖：** 用户批准进入实施后执行；当前仅写计划。  
**文件：** 新增 `docs/acceptance/feasibility.md`、`docs/decisions/0001-write-path.md`；隔离实验放入 `experiments/product-feasibility/`，默认不加入运行包。  
**产出：** 接入前提矩阵、干净机器打包报告、真实编辑器竞争和中断实验、继续或降级结论。

- [ ] 确认工作区及测试夹具目录；实验只使用复制的示例文件，不对用户真实项目做故障注入。
- [ ] 按未配置用户与已有域名／OAuth 用户分别走一遍安装链路，记录外部准备、界面操作和等待三类时间。
- [ ] 验证首版运行包能在没有 Python／Node 的 Windows 环境启动；记录动态依赖、认证存储与静态资源是否完整。
- [ ] 在真实 VS Code 中复现：预检通过后立刻输入、自动保存、两窗口、窗口失联、后台文件变化；用前后字节和文档版本确认是否存在静默覆盖。
- [ ] 在替换前、替换后终态前、撤销中模拟进程中断，验证可以用日志和文件哈希识别实际结果；不把 SQLite 提交当作文件事务完成。
- [ ] 形成写入方案决策记录；若现有服务写入无法保护已承诺的编辑场景，先调整写入路径并重新评审，或明确只读／补丁降级，不扩大功能包装。

**验收：** 三项技术实验和上手路径均有可复现证据；无明确写入方案时 T06 可继续研究状态存储，但不得宣称 v0.3 自动应用可交付。实验代码不直接作为生产实现。

### T01：建立开源与可复现基线

**依赖：** T00 的基线结论；用户确认范围、开源意向及许可证。  
**文件：** `README.md`、`pyproject.toml`、`extensions/vscode/package.json`、`extensions/vscode/LICENSE.txt`、`extensions/vscode/integration/run.js`；新增 `LICENSE`、`CONTRIBUTING.md`、`SECURITY.md`、`CODE_OF_CONDUCT.md`、`CHANGELOG.md`、`.github/ISSUE_TEMPLATE/*`、`.github/PULL_REQUEST_TEMPLATE.md`。

- [ ] 确认真实仓库根目录；若没有仓库，先检查应排除的状态与凭据文件，再建立仅包含可公开文件的基线，不执行全目录无审查提交。
- [ ] 按权利人确认结果替换许可，统一扩展和 Python 元数据，列出第三方依赖与运行时的分发要求。
- [ ] 扩展集成测试改为接受 `VSCODE_EXECUTABLE_PATH`；未提供时由测试框架安装指定测试版本，去掉作者机器路径。
- [ ] 在新工作目录按文档安装依赖并执行基线测试，保存实际结果，区别历史报告。
- [ ] 启用 `.github/workflows/ci.yml` 的最低可用流水线：Python 核心、Node 扩展逻辑、格式检查、产物排除验证；后续任务逐步添加其测试，不等 T11 才启用。
- [ ] 增加架构依赖检查：领域和存储不导入 HTTP／MCP／VS Code 适配层；贡献指南提供离线夹具和明确的模块入口。
- [ ] 为发布文件设置白名单；用包含测试令牌、测试日志、模拟 OAuth 存储的目录验证这些文件不会打进包。
- [ ] 评审可公开文件列表并提交基线；此步骤不创建公开远端、不推送。

**验证命令：** `powershell -NoProfile -File scripts/self-test.ps1`；项目根目录 `npm run test:e2e`；扩展目录 `npm run test:integration`。

**验收：** 另一台机器无需修改作者路径即可运行；包中不含个人配置与状态；许可证和包元数据一致。

### T02：稳定协议与真实连接状态

**依赖：** T01。  
**文件：** 新增 `protocol.py`、`health.py`、`tests/test_health.py`；修改 `admin.py`、`server.py`、`cli.py`、`static/app.js`。

**接口：** `HealthRegistry.snapshot() -> dict[str, HealthCheck]`；`HealthRegistry.record(layer, state, error_code=None) -> None`；层名称固定为 `local_service`、`transport`、`oauth`、`tool_call`。

- [ ] 添加测试：只有配置文件不能产生 `tool_call=ok`；授权失败不清除本地服务正常状态；超过有效期显示过期。
- [ ] 新增服务版本及能力响应，保留旧 `/api/status` 可兼容字段，不再把固定布尔值当成真实验证结果。
- [ ] 验证模型导出到 `contracts/generated/`，增加重生成无差异检查；扩展以相同夹具验证缺少字段、未知次版本字段和主版本不兼容。
- [ ] 定义 `runtime_limits.py`：读取并发 4、排队 32，健康及状态查询独立小额预算；队列满返回忙碌状态，取消释放名额。
- [ ] 设计有时限的验证挑战：本机发起验证，绑定项目、预期工具与随机标识；只有认证后的远程调用携带标识并实际读取成功才记录成功。普通 MCP Inspector 探测显示“客户端调用成功”，不能自动冒充 ChatGPT 验证。
- [ ] `/doctor` 输出四层状态、错误码、可执行修复建议；日志输出不得包含 OAuth 密钥。
- [ ] 运行测试和管理页状态验证，评审后提交。

**测试契约示例：**

```python
from project_mcp.health import HealthRegistry

def test_local_health_does_not_claim_remote_success():
    health = HealthRegistry()
    health.record("local_service", "ok")
    result = health.snapshot()
    assert result["local_service"]["state"] == "ok"
    assert result["tool_call"]["state"] == "unknown"
```

**运行：** `.venv\Scripts\python.exe -m pytest tests/test_health.py tests/test_services.py -q`。  
**验收：** 连接页面能区分本地未启动、通道失败、OAuth 失效、尚无真实工具调用。

### T03：运行包、安装与本机配对

**依赖：** T02。  
**文件：** 新增 `pairing.py`、`scripts/build-runtime.ps1`、`extensions/vscode/lib/service-manager.js`、`tests/test_pairing.py`、`extensions/vscode/test/service-manager.test.js`；修改 `cli.py` 和扩展入口。

**接口：** 扩展 `ensureRuntime(version)` 返回已校验安装路径；`ensureService()` 返回 `serviceUrl`、`apiVersion`、`capabilities`；服务启动从受限本机机制完成凭据配对，不输出明文凭据到普通日志。

- [ ] 先做 Windows 运行包构建验证，建议试用 PyInstaller 单目录产物；验证 FastMCP、认证加密模块和静态文件都可加载，再固定构建依赖版本。
- [ ] 构建清单包含版本、架构、大小、SHA-256 和兼容 API 范围。扩展只从受信发布源获取清单，不接受工作区文件指定下载地址。
- [ ] 测试损坏下载、错误架构、不兼容版本、离线首次启动，失败时保留原安装。
- [ ] 服务数据移到同用户应用数据目录；配对凭据使用同用户访问控制和 SecretStorage，防止匿名本机网页配对。
- [ ] 测试并发启动两个 VS Code 窗口只启动一个实例；端口冲突不杀进程；启动崩溃返回日志入口。
- [ ] 单实例按同用户受管理配置识别；已有手动部署仅在明确选择后复用，扩展不得擅自停止或升级外部服务。
- [ ] 所有窗口共享服务实例但分别持有会话，关闭一个窗口不终止其他窗口使用的服务；退出窗口后禁止发起新本机应用。
- [ ] 5 分钟内异常退出 3 次停止自动拉起；网络断连只重建连接，不重启服务。暂停必须停止重试，继续操作可恢复。
- [ ] 干净 Windows 虚拟机安装运行包，不安装 Python／Node，完成真实读取后提交。

**运行：** `.venv\Scripts\python.exe -m pytest tests/test_pairing.py tests/test_cli.py -q`；扩展目录 `node --test test/service-manager.test.js`。

**验收：** 无开发运行时的新机器能启动；用户无需手动复制管理令牌；旧手动配置仍可迁移。

### T04：项目访问范围与有界读取

**依赖：** T02，UI 依赖 T03。  
**文件：** 新增 `policy.py`、`tests/test_policy.py`；修改 `config.py`、`workspace.py`、`server.py`、`git_read.py`、`context.py`、`tests/test_workspace.py`。

**接口：** `ProjectPolicy.allows(relative_path, capability) -> bool`；能力为 `read`、`propose`、`apply_local`。访问规则来自受保护的本地配置，仓库提供的建议规则不能扩大授权。

- [ ] 写测试覆盖默认只读、项目暂停、规则改变后既有授权失效、秘密文件、越界、junction、大小写等路径情况。
- [ ] 读取、搜索、Git diff、编辑器上下文、修改差异共用策略，避免通过另一接口绕过范围限制。
- [ ] 加入范围预览，显示可访问数量、被排除原因和扫描是否完整；不把预览统计当成每次操作的授权缓存。
- [ ] UI 映射成“仅查看代码／允许提出修改”两种模式；本机应用授权与模式选择分离。默认不发布未保存内容，用户主动开启时解释分享范围。
- [ ] `list_files` 区分下一页和扫描预算耗尽，返回 `next_offset`；明确根目录 `path="."` 及现有 depth 语义。
- [ ] 加入 `read_files(project_id, requests)`，最多 10 个条目，每个独立范围错误，整个结果有总大小预算；保持 `read_file` 行为兼容。
- [ ] 固定大目录测试样本，验证限流、时间和截断反馈后提交。

**运行：** `.venv\Scripts\python.exe -m pytest tests/test_policy.py tests/test_workspace.py tests/test_git_read.py tests/test_windows_boundary.py -q`。

**验收：** 所有读取路径使用同一授权结果；扫描被截断时不能显示“已扫描整个项目”。

### T05：首次使用向导与 v0.2 验收

**依赖：** T03、T04。  
**文件：** 新增 `extensions/vscode/lib/onboarding.js`、`extensions/vscode/test/onboarding.test.js`、`docs/quickstart.md`、`docs/compatibility.md`；修改扩展入口、设置声明、管理页面、`integration/suite.js`。

**接口：** `runOnboarding()` 对用户只显示 `project`、`connection`、`try_question` 三步；内部检查点仍包括 `prerequisites`、`runtime`、`project`、`connection`、`verification`、`complete`。用户输入与运行检查分别持久化，不保存秘密到工作区。

- [ ] 测试取消与重新进入继续原步骤，多根工作区要求明确选择项目，不根据活动窗口猜测另一个项目。
- [ ] 在连接前显示账号前提；自托管向导检查 HTTPS、OAuth 回调和允许账号配置，不把敏感值写入共享工作区。
- [ ] 提供复制端点、打开外部浏览器、复制验证提示词、查看错误详情四种明确操作；不实现网页自动登录。
- [ ] 完成项目首页、待处理修改、设置与诊断；技术状态映射为用户能理解的下一步，详情才展示四层检查。
- [ ] 提供固定示例项目的离线演示，始终显示“演示数据，尚未连接 ChatGPT”；不伪造工具成功，不自动读取用户项目。
- [ ] 实现上下文提问模板和结果查询模板复制，包含明确项目／文件／修改编号但无秘密；不声称自动发送到网页。
- [ ] 验证键盘、焦点、读屏标签、明暗主题；用户能辨认已接收、已应用、未测试三种状态。成功读取不弹窗，重复错误合并。
- [ ] 观察 3 名新用户完成首次与二次使用，记录步骤卡点、求助次数和全部准备耗时；修复关键问题后再开始完整修改界面。
- [ ] 用正式安装 VSIX、真实服务、真实通道完成 ChatGPT 的项目列表、文件读取及断连重试；账户授权由用户本人执行。
- [ ] 更新 README 和兼容表，只标记已验证组合；形成 v0.2 候选包和验收报告。

**运行：** 扩展目录 `npm run check`、`npm run test:integration`；根目录 `npm run test:e2e`。  
**验收：** 满足设计稿中的安装与新用户上手门槛；未通过则继续修复，不进入写入功能公开发布。

### T06：持久化修改单与去重

**依赖：** T04；对外发布依赖 T05。  
**文件：** 新增 `changes/__init__.py`、`changes/models.py`、`changes/store.py`、`changes/content.py`、`tests/test_changes_store.py`。

**接口：** `ChangeStore(db_path, content_store)`；`create(actor_id: str, request: ChangeRequest) -> ChangeResult`；`get(actor_id, project_id, change_id) -> ChangeResult`。`ProtectedContentStore(root, key_provider)` 提供 `put_bytes(data) -> str`、`get_bytes(blob_id) -> bytes`，密钥提供者为可注入的独立适配器。

- [ ] 写重复请求、同键异内容、跨身份查询、重启持久化、保留期及未解决恢复记录保护的失败测试。
- [ ] SQLite 建立请求唯一约束和状态转换条件；并发提交不能产生重复记录。
- [ ] 每次状态转换校验预期状态及 revision；操作记录涵盖应用、拒绝、恢复与撤销，保存 transaction_kind，终态查询无需新租约。
- [ ] 修改单清单不可变，摘要覆盖路径、操作、基准哈希和内容哈希；规范序列化保持重复提交判断稳定。
- [ ] 原始内容与备份存入加密 blob；Windows 下用操作系统凭据保护密钥，测试密钥丢失时停止操作且不清空恢复数据。
- [ ] 验证配额在接收和解码后都生效，超限请求不能先完整装入内存再拒绝。
- [ ] 全局最多 100 份待审阅单、1 GiB 受保护内容与备份；新提交超额被拒绝，清理不能删除活跃事务引用的 blob。
- [ ] 测试内容写入成功而数据库提交失败、数据库损坏、密钥不可用、保留期清理与重启；回收孤立 blob 时不删除尚未完成提交引用的内容。
- [ ] 固定数据库事务与持久化策略，加入数据库快照、blob 引用核验及成套恢复夹具；后续升级直接复用。
- [ ] 运行状态与并发测试，检查数据库和日志未含明文内容后提交。

**测试契约示例：**

```python
from project_mcp.changes.store import ChangeStore
from project_mcp.changes.content import ProtectedContentStore

def test_same_request_survives_restart(tmp_path, test_key_provider):
    # tests/conftest.py 提供只用于测试的内存密钥适配器，绝不进入运行包。
    content = ProtectedContentStore(tmp_path / "content", test_key_provider)
    database = tmp_path / "changes.db"
    request = {
        "project_id": "demo", "request_id": "request-001", "summary": "新增说明",
        "files": [{"path": "README.md", "operation": "create",
                   "base_sha256": None, "content_utf8": "# Demo\n"}]
    }
    first = ChangeStore(database, content).create("owner", request)
    second = ChangeStore(database, content).create("owner", request)
    assert first["change_id"] == second["change_id"]
    assert second["state"] == "pending_review"
```

**运行：** `.venv\Scripts\python.exe -m pytest tests/test_changes_store.py -q`。  
**验收：** 同请求重试 100 次仅一份记录；同键异内容返回明确冲突；重启后可查。

### T07：版本校验、写入与恢复执行器

**依赖：** T06，以及 T00 明确通过或调整后的写入路径结论。  
**文件：** 新增 `changes/executor.py`、`changes/recovery.py`、`tests/test_changes_executor.py`、`tests/test_changes_recovery.py`。

**接口：** `ChangeExecutor.apply(change_id) -> ChangeResult`；`recover(change_id, action) -> ChangeResult`，其中 action 为 `verify` 或 `rollback`；`revert(change_id) -> ChangeResult`。构造时注入授权项目、策略、存储及可替换的文件操作适配器，以便故障注入。

- [ ] 先覆盖基准哈希不匹配、创建目标已存在、路径逃逸、文件被占用、写入中断测试。
- [ ] 拒绝规范化重复路径、Windows 大小写别名和硬链接目标；替换前后校验文件权限和必要元数据，防止临时文件替换放宽原权限。
- [ ] 对整份修改单执行预检并持久化清单、原始备份和写前日志；首版全服务同时最多一个文件修改事务，按项目维持恢复隔离。
- [ ] 实现同目录临时写入和平台替换；创建操作必须保证不覆盖已有文件，不以一次存在检查代替创建约束。
- [ ] 在备份完成、替换前、每文件替换后、写终态前注入故障；重启后对照前后哈希恢复状态。
- [ ] 实现有条件回滚与撤销，遇到用户后续修改转入冲突或恢复状态，不运行 `git reset`。
- [ ] 撤销先持久化 reverting 与逆向事务日志，在每个恢复文件和终态前注入故障；重启按 transaction_kind 恢复，不能把部分撤销显示为原应用完成。
- [ ] 拒绝／暂停只取消尚未开始操作；撤销共享发生在写入中时，完成当前单文件落盘并记日志，再停止后续文件并进入恢复状态。
- [ ] 明确多文件非原子边界；恢复完成前阻止同项目进一步写入。
- [ ] 执行真实 Windows 文件系统、CRLF、BOM、Unicode 路径、权限与锁冲突测试后提交。

**运行：** `.venv\Scripts\python.exe -m pytest tests/test_changes_executor.py tests/test_changes_recovery.py tests/test_windows_boundary.py -q`。

**验收：** 每个故障点均有确定可解释的状态与恢复数据；回滚不得覆盖不匹配的当前内容。

### T08：MCP 提交、查询和本机应用接口

**依赖：** T06、T07、T04。  
**文件：** 新增 `changes/service.py`、`tests/test_changes_api.py`；修改 `server.py`、`admin.py`、`auth.py`、`protocol.py`。

**接口：** 采用设计稿第 8 节的三个远程工具和本机应用路由；本机应用在 T09 租约校验接入前保持禁用，内部执行器只允许测试调用。

- [ ] 使用真实 HTTP 测试远程调用不能访问批准／应用／恢复接口；无权限项目不能提交或查询另一身份的修改单。
- [ ] 身份从认证上下文派生，配置 `project:read` 与提交能力映射；不得相信请求携带的 actor 字段。
- [ ] 工具提交完成持久化后立即返回编号和待审阅状态，工具描述说明“尚未修改本地文件”。
- [ ] 将提交工具标为有状态变更，查询工具只读；为当前依赖版本添加实际工具清单契约测试。
- [ ] 工具结果使用有界摘要；差异查询遵守读取策略与总输出限制。
- [ ] 用同请求重复调用及响应丢失模拟验证状态查询，评审后提交。
- [ ] 应用请求带 operation_id、expected_revision，先查幂等操作结果再验证新租约；断网重试原操作不得再次写入，未知／超期记录不得由客户端自动重放。
- [ ] 引入 capability 降级：内容存储坏了禁用提交和应用、保留有效授权的读取；OAuth 失效禁用远程入口但本地历史可查。

**运行：** `.venv\Scripts\python.exe -m pytest tests/test_changes_api.py tests/test_services.py tests/test_auth_storage.py -q`。

**验收：** 远程提交能落库和查询，任何远程请求均不能直接写入文件；不兼容客户端无法误用写功能。

### T09：VS Code 差异审阅与实时就绪检查

**依赖：** T05、T08。  
**文件：** 新增 `editor_readiness.py`、`extensions/vscode/lib/changes.js`、`extensions/vscode/lib/readiness.js`、`tests/test_editor_readiness.py`、`extensions/vscode/test/changes.test.js`；修改扩展入口和管理路由。

**接口：** 服务 `issue_readiness_lease(change_id, review_session_id, manifest_sha256)`；租约最多 5 秒，只用于对应清单的一次应用。扩展 `showChange(changeId)`、`applyReviewedChange(changeId, manifestSha256)`，实际调用由本地用户按钮触发。

- [ ] 增加真实 Extension Host 测试：打开差异后再编辑、未保存文档、两个已登记窗口、其中一个窗口失联。
- [ ] 注册活动审阅会话；应用前查询所有相关已登记会话，未知、过期或 dirty 时返回阻止原因。
- [ ] EDITOR_DIRTY、EDITOR_UNAVAILABLE、LEASE_EXPIRED 保持 pending_review，提供“打开文件／重试检查”；只有 FILE_CHANGED 进入 conflict 并要求新建议。
- [ ] 展示原始内容与预期内容的差异，明确来源项目；预览内容改变则必须新建修改单，不复用授权。
- [ ] 应用点击创建短期就绪租约；服务器在最终应用前重新检查版本和租约。连接断开、文档变化或工作区解绑使租约失效。
- [ ] 增加“应用、拒绝、查看恢复、撤销”操作；页面可见每 3 秒轮询、隐藏每 30 秒，每次只一个请求，以 revision 丢弃旧响应。首版不实现事件流。
- [ ] 实现 `view-state.js` 的纯映射测试，保证所有后台状态均有可理解文案和一个主要操作；应用按钮连击复用 operation_id。
- [ ] 显示备份到期时间及能否撤销；已应用但尚未测试的提示始终准确；网页结果查询模板使用对应修改编号。
- [ ] 通过真实服务测试后才打开本机应用能力。任何无法解决的编辑竞争都必须阻止发布写能力，而非在文档中宣称完全安全。
- [ ] 记录未参与协议的外部编辑进程限制，评审后提交。

**运行：** `.venv\Scripts\python.exe -m pytest tests/test_editor_readiness.py tests/test_changes_api.py -q`；扩展目录 `node --test test/changes.test.js`、`npm run test:integration`。

**验收：** 网页提交后扩展显示同一修改单；点击应用前不改磁盘；脏文档及失效租约不写入。

### T10：诊断、故障演练与 v0.3 验收

**依赖：** T07–T09。  
**文件：** 新增 `diagnostics.py`、`tests/test_diagnostics.py`、`tests/test_fault_recovery.py`、`tests/e2e/changes.cjs`、`docs/acceptance/changes-beta.md`；修改 CLI、管理页和扩展活动视图。

**接口：** `record_event(event)` 只接受白名单元数据；`export_diagnostics(destination, include_paths=False)` 默认去除绝对路径、令牌、内容和用户身份细节。

- [ ] 先测试日志和诊断包对令牌、源文件内容、OAuth 返回的脱敏；用户导出前能预览内容范围。
- [ ] 给活动记录关联请求编号、修改编号、错误码、持续时间和各层连接状态；设置日志大小和保留期。
- [ ] 完成睡眠恢复、断网、服务被终止、响应超时、磁盘不足、文件占用、权限撤销场景。
- [ ] 添加高负载隔离：读取队列已满时状态查询仍返回；网络断连时本地历史可读；SQLite 损坏时不能自动清空重建。
- [ ] 通过虚拟时钟验证 1、2、4、8、16、30 秒重连退避、抖动上限、暂停取消和认证失败停止重试；避免依赖长时间真实等待的脆弱测试。
- [ ] 执行正式 VSIX → 真实服务 → 实际远程通道 → ChatGPT → 本地应用 → 网页查询的完整链路。
- [ ] 确认网页不会把 pending 状态解读为已完成；记录用户必须主动追问查询的实际体验。
- [ ] 按设计稿质量门槛整理 v0.3 候选包，仍失败的场景列为发布阻断项。

**运行：** `.venv\Scripts\python.exe -m pytest tests/test_diagnostics.py tests/test_fault_recovery.py -q`；根目录 `node tests/e2e/changes.cjs`。

**验收：** 修改结果、原文件和日志一致；故障可诊断；真实网页验收与自动化报告分别归档。

### T11：升级、兼容性与候选发布流水线

**依赖：** T10。  
**文件：** 修改运行包构建脚本、扩展 service-manager、`config.py`；新增 `tests/test_upgrade.py`、`.github/workflows/ci.yml`、`.github/workflows/release-candidate.yml`、`docs/releasing.md`。

**接口：** `prepare_upgrade(target_version) -> snapshot_id` 创建程序／配置／数据库／blob 引用一致快照；`migrate_config(source_version, target_version)` 与存储迁移在升级事务内执行。存在 applying、reverting 或 recovery_required 时拒绝更新。

- [ ] 测试 v0.2 → v0.3 → v1.0 配置迁移、损坏下载、校验失败、不兼容 API 和回退启动。
- [ ] 保留上一可用运行包与配置；安装新包失败不能覆盖旧包。自动升级默认需用户本地启动，不允许远程 MCP 触发。
- [ ] 升级期间暂停新修改，使用数据库支持的备份方式并核验所有活跃 blob；回退必须恢复成套程序与数据，禁止旧二进制直接打开新数据库结构。
- [ ] 新版本健康和迁移验收前不开放写入；已产生新修改后禁止静默恢复旧快照，提供明确修复路径避免丢失记录。
- [ ] CI 覆盖 Python 最低与主用版本、VS Code 当前与前一 Stable；实际发现最低版本不兼容则提高声明并重新验收。
- [ ] 在 T01 流水线上增加当前／前一稳定扩展服务组合契约测试；冻结候选包对应的宿主版本，不让 latest 标签漂移改变发布验收结果。
- [ ] 构建 wheel、VSIX、Windows 运行包、校验和及依赖清单；公开发布与候选构建分离。
- [ ] 候选包执行敏感文件白名单检查和干净机器安装测试；签名证书未准备时如实标记产物状态。
- [ ] 验证升级与卸载操作保留用户源码，清理范围只包含本工具已确认拥有的路径。

**运行：** `.venv\Scripts\python.exe -m pytest tests/test_upgrade.py -q`；干净 Windows 虚拟机执行候选安装、升级、回退与卸载。

**验收：** 失败升级可恢复，用户项目文件不受卸载影响，候选产物可复现且版本一致。

### T12：试用反馈与 v1.0 发布评审

**依赖：** T11。  
**文件：** `README.md`、新增 `README.en.md`、`docs/acceptance/v1.md`、`docs/troubleshooting.md`、`docs/compatibility.md`、`CHANGELOG.md`。

- [ ] 招募 5 名符合首版前提的目标用户，按设计稿计时与记录步骤卡点，不由维护者代配全部步骤。
- [ ] 分别记录已有接入资源和没有资源的用户；缺前提者应在 2 分钟内理解限制并找到演示或配置入口，不能把他们从易用性结论中静默排除。
- [ ] 同时验收二次使用、共享范围理解、未保存内容分享、待审阅与已应用的区别、错误后的下一步；自动配置成功不等于用户理解正确。
- [ ] 优先修复安装失败、连接难诊断、应用结果含糊和恢复阻塞，随后再调整视觉细节。
- [ ] 执行完整回归与 24 小时稳定性测试，记录明确环境、样本量、版本和失败数。
- [ ] 制作真实演示：安装 → 授权 → 网页读取 → 提出修改 → VS Code 应用 → 查询结果 → 撤销。
- [ ] 确认开源仓库、发行包、许可、第三方声明、隐私说明、支持渠道和兼容矩阵一致。
- [ ] 形成可审阅发布清单和已知限制。用户确认公开发布范围后，再执行推送、Release 或市场发布。

**验收：** 设计稿第 10 节目标有对应证据；新用户可完成核心闭环；无未解决的数据丢失、越界写入或恢复状态不明问题。

## 5. 回归与验收执行规则

已有命令：

```powershell
# 在项目根目录执行
powershell -NoProfile -File .\scripts\self-test.ps1
npm run test:e2e

# 进入扩展目录后执行
npm run check
npm run test:integration
npm run package
```

新增测试路径在任务落地后才可运行。新任务先执行相关测试，里程碑再跑完整回归；不为文案修改反复运行无关重型测试。

真实网页测试记录：安装包版本、服务版本、VS Code 版本、日期、连接方式、账号接入条件、提示词、工具名称、参数、脱敏结果、文件前后哈希、是否需要确认。不能把单次成功报告为所有账号和网络都稳定。

性能记录严格区分本地处理时间、网络时间和模型生成时间。质量门槛有失败时，记录原因和修复任务，不通过缩小统计口径隐藏失败。

## 6. 不纳入本轮的独立工程

| 工程 | 启动条件 | 独立交付边界 |
|---|---|---|
| 托管连接 | 明确运营责任、预算和数据处理方式，验证目标账号可接入 | 稳定公共入口、设备绑定、身份隔离、断线恢复、限流和可观测；继续保留自托管 |
| macOS／Linux | Windows 读写状态机稳定，有对应测试环境 | 运行包、凭据保护、路径语义、签名与安装、真实编辑器测试 |
| Claude 等助手 | 有测试账号和明确接入文档 | 工具发现、OAuth、确认、超时与状态查询的完整验收 |
| 自动运行测试 | 用户明确需要，命令授权模型经过设计 | 受控任务清单、工作目录、进程终止、输出限制；不直接开放任意 shell |
| 远程应用修改 | 明确需求且已有恢复机制 | 项目范围、有效期、授权来源、用户撤销和平台确认策略的单独评审 |

## 7. R2 需求与验收追踪

| 编号 | 角度与要求 | 实施任务 | 必须留下的证据 |
|---|---|---|---|
| U01 | 三步上手、一个项目首页 | T05 | 新用户首次与二次使用观察、实际界面截图 |
| U02 | 提前识别接入门槛、可恢复配置与演示 | T00、T05、T12 | 完整准备耗时、缺条件用户反馈、演示与真实状态区分 |
| U03 | 两种权限模式与明确的分享范围 | T04、T05 | 权限行为测试、用户理解结果 |
| U04 | 一次应用、明确结果、能继续处理错误 | T08、T09、T10 | 预览、暂时阻塞重试、已应用未测试、结果查询闭环 |
| U05 | 键盘可用、通知克制、下一步清楚 | T05、T09、T12 | 键盘与读屏检查、状态文案映射测试 |
| S01 | 提前证明写入与恢复可行 | T00、T07、T09 | Windows 编辑竞争与中断实验、继续或降级决策 |
| S02 | 单一契约和模块依赖方向 | T01、T02、T08 | 契约生成无漂移、跨语言夹具、结构测试 |
| S03 | 持久化、操作幂等、撤销可恢复 | T06–T10 | 重试 100 次、双击应用、重启和撤销故障注入 |
| S04 | 负载有界、失败可降级、重连受控 | T02、T03、T06、T10 | 队列满／配额满、虚拟时钟重连、服务隔离测试 |
| S05 | 程序与数据成套升级回退 | T06、T11 | 数据库／blob／密钥一致快照、新旧组合验证 |
| S06 | 社区能贡献、版本可维护 | T01、T11、T12 | 无账号核心测试、支持矩阵、CI 及发布演练 |

每条需求必须有实际证据才能标记完成。试用未达标时记录具体失败步骤；写入保护未达标时停止该能力发布；不因为文档已经描述方案就标记通过。

## 8. 评审结论填写项

以下是用户确认项，不是尚未设计的占位内容；本稿已给出推荐方案。

- [ ] 同意首版范围：个人开发者、Windows 11 x64、VS Code、本地项目、ChatGPT 网页。
- [ ] 同意先自托管 Beta，再单独建设托管连接。
- [ ] 同意网页提交修改、本地审阅应用；首版无远程直接写入和任意命令执行。
- [ ] 确认许可证选择及可公开源码范围。
- [ ] 确认按 v0.2 → v0.3 → v1.0 分阶段执行，阶段验收后更新工期估算。
- [ ] 同意 R2 先执行 T00 风险验证、T01 启用 CI、T05 提前试用；写入风险未解决时保持只读／补丁交付。

本次交付仅更新为 R2 待评审设计与计划，共 T00–T12 十三个工作包；尚未实施以上任务，也没有运行这些未来功能的测试。
