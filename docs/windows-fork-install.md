# 在 Windows 安装此 UI 修复版

此 fork 基于 `flizzywine/dsh-tavern`，只修改 Tavern 的界面样式和对应的前端构建文件：修正左侧栏标题位置，并让确认框、选卡弹窗、悬浮菜单等浮层使用不透明的主题底色。

## 命令行安装

先安装 Node.js 22.19 或更新版本。然后在 Windows PowerShell 中运行：

```powershell
$env:DSH_TAVERN_HOST = 'cli'
$env:DSH_TAVERN_REPOSITORY = 'WhaleFell1344/dsh-tavern'
$tavernInstaller = [Text.Encoding]::UTF8.GetString((New-Object Net.WebClient).DownloadData('https://raw.githubusercontent.com/WhaleFell1344/dsh-tavern/main/install.ps1'))
Invoke-Expression $tavernInstaller
```

安装器会从此 fork 的 `main` 分支下载 Tavern；Git 可用于增量同步，但不是必须安装。以后在新 PowerShell 窗口使用 `dsh-tavern start` 启动，或使用 `dsh-tavern open` 打开当前服务。

上游发布的 Windows Setup EXE 在构建时固定指向原仓库，不能用它安装此 fork；请使用上面的 PowerShell 命令。

## 接入同一台 Windows 电脑上的 Ollama

在 Tavern 的「设置 → 模型」添加自定义模型 API，协议选 **OpenAI Chat Completions**，Base URL 填 `http://127.0.0.1:11434/v1`，模型 ID 填 `ollama list` 中的名称。若要求 API Key，可填占位值 `ollama`。

不同安装环境的聊天、人物卡和模型设置各自保存在本机数据目录；此仓库不包含个人数据。
