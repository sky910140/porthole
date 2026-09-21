# 文件写入与恢复验收

日期：2026-09-21  
范围：Task 7，Windows 本地文件系统

## 写入边界

- 所有创建、修改、回滚和撤销都经过 `ChangeExecutor`；不调用 `git reset`，不删除或重命名用户文件。
- 整单先完成路径、策略、基准哈希、硬链接、重解析点和内容校验，再保存原始字节及写前事务日志。
- 修改通过同目录临时文件和 `os.replace` 完成；Windows 替换前复制原文件所有者、组和 DACL。创建通过临时文件和不覆盖的硬链接落点完成。
- 多文件不是原子事务。每个文件完成后单独更新持久化阶段；中断后同时检查事务类型、逐文件记录和磁盘哈希。
- 全服务文件修改使用一个写锁。项目存在 `recovery_required` 时，新的同项目写入被拒绝。

## 故障结果

| 故障位置 | 可观察结果 |
|---|---|
| 备份及日志完成、首个替换前 | 核验为 `rolled_back`，磁盘保持原内容 |
| 单文件替换后 | 核验为 `recovery_required`；安全回滚后为 `rolled_back` |
| 所有替换后、终态前 | 核验为 `applied`，不会重复写入 |
| 撤销所有文件后、终态前 | 按 revert 事务核验为 `reverted` |
| 磁盘出现未知后续内容 | 保持 `recovery_required`，回滚不覆盖用户内容 |
| Windows 文件被真实句柄占用 | 替换失败并安全回滚，原字节保持不变 |

CRLF、UTF-8 BOM 字节、Unicode 路径、只读位/权限模式、创建目标已存在、基准变化、符号链接和硬链接均有行为测试。符号链接测试在当前权限不能创建链接时显式跳过；junction 越界由现有 Windows 边界测试覆盖。

## 自测命令

```text
pytest tests/test_changes_executor.py tests/test_changes_recovery.py tests/test_windows_boundary.py -q
ruff check src tests scripts packaging
```
