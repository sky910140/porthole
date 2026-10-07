# Windows 独立运行包

运行包使用 PyInstaller 单目录模式，不要求目标机器安装 Python 或 Node。构建依赖固定在 `requirements-build.txt`。

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-build.txt
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-runtime.ps1
.\.venv\Scripts\python.exe scripts\verify_runtime.py artifacts\runtime\dist\porthole\porthole.exe
```

构建输出位于被 Git 忽略的 `artifacts/runtime/`：

- `dist/porthole/`：可直接运行的目录；
- `porthole-windows-x64.zip`：分发归档；
- `runtime-manifest.json`：版本、协议范围、平台、架构、大小和 SHA-256；
- `build/`：PyInstaller 中间文件和警告报告。

受管理安装位置固定为 `%LOCALAPPDATA%\Porthole\runtime\current`，配置为 `%LOCALAPPDATA%\Porthole\config.json`。扩展不从工作区设置读取下载地址。正式在线下载功能只有在项目确定并编译进受信发布源后才启用；当前候选版从 VSIX 离线安装。缺少内置运行包和现有安装时会明确失败，已有完整安装不会被损坏包替换。

0.3.0 本地候选 VSIX 改为内置 Windows x64 运行包。用户在 VS Code 首页点击“安装本机服务”后，扩展根据 `runtime-bundle/bundle.json` 逐文件验证版本、协议范围、路径、大小和 SHA-256，先复制到暂存目录再替换安装；失败时保留原安装。构建候选 VSIX 使用 `scripts/package-extension.ps1`，它先重建运行包，再写入清单并打包扩展。`scripts/verify-vsix.py` 会从最终 VSIX 解包、安装到隔离目录，并在不含 Python/Node 的目标 PATH 下启动服务和读取真实文件。

扩展执行 `pair` 命令取得两分钟有效的一次性随机码，再通过回环接口交换长期管理凭据。磁盘只保存配对码 SHA-256，消费或过期后删除；长期凭据只存服务的用户数据目录和 VS Code SecretStorage。手动服务必须由用户明确选择，扩展不会停止或升级它。
