# 项目访问策略与有界读取验收

日期：2026-09-21  
范围：Task 4，Windows 本地项目

## 结果

- 新登记项目默认为 `read_only`，未单独授权时不共享编辑器未保存内容，也不允许本机应用。
- `read_only` 与 `propose` 使用同一项目策略；切换、暂停或更新排除规则后立即重建工作区授权，不复用旧授权结果。
- 文件列表、文件读取、批量读取、搜索、Git 状态与差异、编辑器上下文都经过同一策略对象。
- 内置秘密路径匹配不区分大小写；仓库建议规则只能增加排除范围，不能扩大本机授权。
- 管理页分别显示项目模式、编辑器缓冲区共享和本机应用授权。允许提出修改不自动打开本机应用。

## 有界读取语义

- `list_files(path=".")` 的 `depth` 延续现有语义；`next_offset` 只在存在下一页时返回。
- `truncation_reason=page_limit` 表示可按 `next_offset` 翻页；`scan_limit` 表示扫描不完整且没有误导性的下一页游标。
- `read_files` 每次最多 10 个条目，总返回文本预算 2 MiB；一个条目越界或无权访问不影响其他条目。
- `preview_scope` 返回可访问文件数、按原因统计的排除项、已扫描条目数和扫描是否完整。该结果只作预览，不缓存授权。

## 验证

```text
pytest tests/test_policy.py tests/test_workspace.py tests/test_config_context.py
       tests/test_services.py tests/test_git_read.py tests/test_windows_boundary.py -q
62 passed, 1 skipped

ruff check src tests scripts packaging
All checks passed!
```

跳过项是仅在 Windows 支持 junction 的边界测试；本轮执行环境中其平台前提未满足时由测试显式跳过。浏览器管理页和 VS Code 扩展验证在本任务最终自测中另行记录。
