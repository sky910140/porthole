# 修改单远程接口验收

日期：2026-09-21  
范围：Task 8

## 接口边界

- `propose_changes` 只创建 `pending_review` 修改单，返回 `local_files_changed=false`；远程 MCP 不提供批准、应用、撤销或恢复工具。
- `get_change_status` 返回状态、revision、清单哈希和文件元数据；`get_change_diff` 返回受总字节预算限制的统一差异。
- 身份从 FastMCP 已验证访问令牌派生，请求模型没有 `actor_id`。修改单按身份、项目和修改编号联合查询，跨身份查询统一返回记录不可用。
- 项目必须处于“允许提出修改”模式，且每个路径仍需通过项目读取和排除策略。暂停项目会阻止提交与查询内容。
- 提交工具标记为有状态、非破坏、可幂等重试；两个查询工具标记为只读。

## 本机边界与降级

- 本机管理接口可列出持久化历史；该接口只监听回环地址并要求独立管理令牌。
- 本机应用路由要求 `operation_id` 和 `expected_revision`。Task 9 的编辑器就绪租约接入前固定返回 `EDITOR_UNAVAILABLE`，相同操作重试返回同一结果，不写文件。
- 内容密钥、加密 blob 或 SQLite 不可用时，提交与差异查询返回通用 `STORAGE_UNAVAILABLE`，不泄露底层路径或凭据错误；已有项目读取工具继续工作。
- OAuth 失效由远程认证层拒绝请求，不影响持有本机管理令牌的历史查询。

## 自测结果

```text
pytest tests/test_changes_api.py tests/test_services.py tests/test_auth_storage.py tests/test_protocol.py -q
19 passed

ruff check src tests/test_changes_api.py
All checks passed!
```

真实 HTTP 边界测试确认 MCP 端口上的应用、批准和恢复路径均为 404。实际工具清单测试确认远程输入不含身份字段，提交和查询 annotations 与接口语义一致。
