# MCP 工具与高级使用

普通用户先看 [操作手册](beginner-manual.md)。本页说明 0.9.1 工具范围、本机测试客户端和已有基础设施的手动部署。

## MCP 工具

| 工具 | 功能 |
|---|---|
| `list_projects` / `workspace_info` | 项目标识、访问模式、Git 分支和提交信息 |
| `list_files` | 分页列出允许访问的文件，区分下一页与扫描预算耗尽 |
| `search_code` | 有界固定字符串搜索，附文件和行号 |
| `read_file` / `read_files` | 按行读取文本，附校验信息；批量最多 10 个文件 |
| `read_table` | 有界读取 UTF-8 CSV 或 XLSX 的工作表、行和列；不计算公式 |
| `preview_scope` | 预览文件清单、排除原因及扫描完整性 |
| `git_status` / `git_diff` | 授权范围内的已保存变更 |
| `list_editor_sessions` / `get_editor_context` | 列出未过期会话，读取单独授权的文本、选区和诊断 |
| `verify_connection` | 消费本机限时挑战，通过实际项目读取验证连接 |
| `propose_changes` | 创建待本机审阅的修改单，不写项目文件 |
| `get_change_status` / `get_change_diff` | 查询修改状态和受大小限制的差异 |

`list_files` 的 `read_as` 标出表格、已知不支持的二进制文件及文本候选。`has_more`、`next_offset` 表示可继续翻页；`truncation_reason=scan_limit` 表示扫描预算耗尽，需要缩小目录，不能视为已经读取全部项目。

`read_table` 限制源文件 1 MiB、XLSX 展开内容 16 MiB、单次最多 100 行/50 列、单元格 100 字符和 64 KiB 输出。文件预览清单最多展示 200 项。截断会注明原因。PDF、图片和旧版 XLS 暂不解析。

## 手动启动本机服务

需要 Python 3.11+；Git 功能还需要 Git。在仓库目录执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\token.ps1
```

最后一条命令在自己的终端显示本机管理令牌。打开 `http://127.0.0.1:8766` 后输入令牌；不要把令牌贴到 AI 对话。管理页面只在内存保存令牌，刷新后清除。

首次 setup 默认登记当前仓库，标识为 `current`。可以传 `-ProjectPath 'D:\workspace\my-project' -ProjectId backend`；现有配置不会被覆盖。以管理页面显示的项目标识为准。

```powershell
.\scripts\status.ps1
.\scripts\stop.ps1
```

启停只控制该配置拥有的服务，端口冲突时不会停止其他进程。关闭管理页面不会停止服务。沿用手动服务时，在 VS Code 执行 `舷窗: 配置连接`；扩展不会停止或升级手动服务。

## 本机 MCP 客户端

MCP 地址为 `http://127.0.0.1:8765/mcp`，需要独立 MCP 令牌，不能使用管理令牌：

```powershell
.\scripts\token.ps1 -Kind mcp
```

仅把该令牌用于本机测试客户端。本地令牌模式不能直接配置为公网网页服务；接口没有匿名文件读取能力。

## 高级公网连接

已有 HTTPS 地址和 GitHub OAuth App 时，可从首页选择“高级：公网连接”。向导收集根地址、允许的 GitHub 用户和 OAuth 凭据，检查发现接口；不会替用户创建域名或 OAuth App。

1. 将固定 HTTPS 主机名只映射到 MCP 端口 `127.0.0.1:8765`，不要映射管理端口 `8766`。
2. OAuth App 回调设为 `https://你的域名/auth/callback`。
3. 完成首页配置，在具有自定义 MCP 权限的 ChatGPT 添加 `https://你的域名/mcp`，选择 OAuth 并授权。
4. 在对话里选中应用，发送首页复制的验证提示词，确认当前连接完成真实读取。

CLI 部署时需停止服务后配置 `auth_mode`、HTTPS `public_url`、允许的数字用户 ID，并通过环境变量提供 OAuth 凭据。公网配置与本地令牌模式不能混用，缺少身份参数会拒绝启动。

推荐私有方式见 [快速开始](quickstart.md)。私有隧道不等于公开发布 ChatGPT 插件；公开插件仍需满足平台自己的部署规则。

## 编辑器与修改边界

磁盘工具读取已保存文件。未保存内容需单独授权后由扩展发布内存快照；快照 15 分钟失效。请求必须显式提供项目和会话标识，不自动猜选其他窗口。

“允许提出修改”只开放建议；“允许本机应用”独立控制写入。应用必须在 VS Code 审阅差异后进行，相关窗口在线且没有未保存内容，使用最多 5 秒的一次性就绪租约。其他未接入协议的编辑器内存无法被检测，应用时不要并行修改同一文件。

应用后运行项目自己的测试。磁盘版本变化会阻止写入或撤销，应查看恢复状态，不能强行覆盖。
