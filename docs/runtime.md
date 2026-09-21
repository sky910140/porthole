# Windows 独立运行包

运行包使用 PyInstaller 单目录模式，不要求目标机器安装 Python 或 Node。构建依赖固定在 `requirements-build.txt`。

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-build.txt
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-runtime.ps1
.\.venv\Scripts\python.exe scripts\verify_runtime.py artifacts\runtime\dist\ai-zhagan\ai-zhagan.exe
```

构建输出位于被 Git 忽略的 `artifacts/runtime/`：

- `dist/ai-zhagan/`：可直接运行的目录；
- `ai-zhagan-windows-x64.zip`：分发归档；
- `runtime-manifest.json`：版本、协议范围、平台、架构、大小和 SHA-256；
- `build/`：PyInstaller 中间文件和警告报告。

受管理安装位置固定为 `%LOCALAPPDATA%\AI Zhagan\runtime\current`，配置为 `%LOCALAPPDATA%\AI Zhagan\config.json`。扩展不从工作区设置读取下载地址。正式下载功能只有在项目确定并编译进受信发布源后才启用；离线首次启动会明确失败，已有完整安装不会被损坏下载替换。

扩展执行 `pair` 命令取得两分钟有效的一次性随机码，再通过回环接口交换长期管理凭据。磁盘只保存配对码 SHA-256，消费或过期后删除；长期凭据只存服务的用户数据目录和 VS Code SecretStorage。手动服务必须由用户明确选择，扩展不会停止或升级它。
