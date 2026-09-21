# 编辑器适配接口 v1

本地管理默认 http://127.0.0.1:8766，所有 `/api/*` 请求携带 `Authorization: Bearer <admin token>`。管理 URL 不允许跨域访问，不能通过公网隧道发布。令牌应保存到编辑器自己的秘密存储。

`GET /api/status` 返回 projects（id/name/root）、sessions、auth_mode、mcp_port。root 仅用于本机核对绑定，不经 MCP list_projects 返回。适配器必须确认编辑器根目录与登记项目 root 一致。

`PUT /api/context` JSON：

```json
{
  "project_id": "backend",
  "session_id": "editor-window-project-uuid",
  "path": "src/main.py",
  "version": 5,
  "text": "print('unsaved')\n",
  "selection": {"start_line": 1, "end_line": 1, "text": "print"},
  "diagnostics": [{"line": 1, "severity": "warning", "message": "示例诊断"}]
}
```

行号从 1 开始，路径为相对于登记项目的 POSIX 路径。只接受已经存在的允许文件；未命名文档、新建但未保存到磁盘的文档暂不支持。完整 UTF-8 文本最多 1 MiB；选区最多 262144 字符；诊断最多 100 条，message 最多4096字符、severity最多20字符。相同会话和文件的旧版本会被拒绝。

每个项目/编辑器窗口必须使用独立 session_id。一个会话不能重绑定到另一个项目。每次发布刷新15分钟有效期；关闭、解除绑定时执行 `DELETE /api/context/{session_id}`。服务重启后快照丢弃；适配器应提示重新发布。不要静默把其他工作区的数据代入当前项目。

控制接口：`PUT /api/projects` 登记 `{id,name,root}`，同ID不可覆盖；`DELETE /api/projects/{id}` 撤销授权并清除会话；`POST /api/shutdown` 停止本服务。后两类接口给本地管理界面使用，编辑器上传无需调用。

管理与插件接口是本项目内部协议，不是模型接口。云端 MCP 地址是独立的 8765 端口，仅暴露只读工具。
