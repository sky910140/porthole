# VS Code 差异审阅与就绪租约验收

日期：2026-09-21  
范围：Task 9，Windows 11 x64、VS Code 1.138.0

## 用户流程

1. 网页调用 `propose_changes` 后得到修改编号，本地文件仍未改变。
2. 用户在 VS Code 运行“AI Zhagan: 查看修改建议”，输入编号；扩展按文件打开保存内容与提案内容的差异，标题显示来源项目。
3. 用户明确运行“应用已审阅修改”。扩展先同步所有已打开文件的版本和 dirty 状态，再请求最多 5 秒的一次性租约。
4. 服务在写入前重新检查项目授权、清单哈希、所有相关 VS Code 会话、租约、磁盘基准哈希和恢复状态；检查通过后才调用唯一文件执行器。
5. 应用后明确显示“尚未运行测试”和可撤销截止时间。网页可复制包含对应 `change_id` 的状态查询提示。

应用按钮并发点击复用同一个 `operation_id`。响应丢失后重复原请求会返回已保存结果，不会再次写入。修改内容不可在预览中编辑；内容变化必须创建新修改单并重新审阅。

## 阻止规则

| 条件 | 结果 |
|---|---|
| 审阅会话未知、失联或工作区解绑 | `EDITOR_UNAVAILABLE`，保持 `pending_review` |
| 任一相关已登记窗口有未保存内容 | `EDITOR_DIRTY`，保持 `pending_review` |
| 会话版本在检查后变化或租约超过 5 秒 | `LEASE_EXPIRED`，保持 `pending_review` |
| 磁盘基准在建议后变化 | `FILE_CHANGED`，转为 `conflict`，要求新建议 |
| 中断后磁盘状态无法安全判断 | `recovery_required`，同项目后续写入暂停 |

撤销也要求新鲜、干净的编辑器租约；后续用户修改导致哈希不符时停止撤销。恢复入口使用持久化事务证据，不根据客户端推测结果。

## 自测结果

```text
pytest tests/test_editor_readiness.py tests/test_changes_api.py \
       tests/test_changes_executor.py tests/test_changes_recovery.py -q
28 passed, 1 skipped

extensions/vscode: node --test test/changes.test.js
4 passed

extensions/vscode: npm run test:integration
VS Code 1.138.0 Extension Host exited with code 0
```

真实 Extension Host 用例覆盖“打开差异后继续编辑”：dirty 状态被本机服务拒绝，保存并重新检查后才能应用。服务端虚拟时钟覆盖未知会话、租约过期、两个已登记窗口且其中一个失联；真实文件执行器继续覆盖 Windows 占用、替换中断、撤销中断和未知后续内容。

## 支持边界

就绪协议能约束已登记的 VS Code 窗口，不能观察未接入协议的其他编辑器内存缓冲区。外部进程已经保存到磁盘的变化会被最终 SHA-256 预检阻止；预检与原子替换之间仍不存在跨进程文件事务。首个修改 Beta 的支持范围因此限定为受管理的 VS Code 工作区，使用其他编辑器同时修改同一文件时应先停止应用。产品不宣称能锁定所有外部进程。
