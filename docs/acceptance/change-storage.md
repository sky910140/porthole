# 修改单存储验收

日期：2026-09-21  
范围：Task 6

## 已验证行为

- 相同身份、项目和请求编号并发重试 100 次，只产生一份修改单；同键异内容返回幂等冲突。
- 服务重启后仍返回原修改编号；其他身份查询得到记录不可用，不泄露记录是否存在。
- 修改清单摘要覆盖路径、操作、基准哈希和内容哈希；状态转换使用预期 revision。
- SQLite 不存拟写入正文；加密 blob 经过 Fernet 完整性校验和明文 SHA-256 校验。
- 密钥变化、校验标记丢失、数据库损坏和引用缺失均停止修改存储，不删除原数据。
- 内容写入后数据库失败会留下可识别的孤立 blob；清理只删除超出宽限期且没有引用的对象。
- 待审阅数量、单文件、单请求和内容总量均有硬限制。恢复中的记录不参与自动内容清理。
- SQLite backup API 生成快照后再次核验 blob 引用。

## 本次结果

```text
pytest tests/test_changes_store.py -q
10 passed

ruff check src tests scripts packaging
All checks passed!

scripts/check_architecture.py
architecture check passed for 12 files
```

Windows 默认密钥提供者使用系统凭据后端。自动化测试注入临时密钥，没有读取或写入日常用户凭据。
