$ErrorActionPreference = 'Stop'
$PreviousConsoleOutputEncoding = [Console]::OutputEncoding
$PreviousOutputEncoding = $OutputEncoding

$InstallHost = if ($env:DSH_TAVERN_HOST) { $env:DSH_TAVERN_HOST } else { 'cli' }
if ($InstallHost -notin @('cli', 'desktop')) { throw "不支持的安装宿主：$InstallHost" }

$Repository = if ($env:DSH_TAVERN_REPOSITORY) { $env:DSH_TAVERN_REPOSITORY } else { 'flizzywine/dsh-tavern' }
$RepositoryUrl = if ($env:DSH_TAVERN_GIT_URL) { $env:DSH_TAVERN_GIT_URL } else { "https://github.com/$Repository.git" }
$ArchiveUrl = if ($env:DSH_TAVERN_ARCHIVE_URL) { $env:DSH_TAVERN_ARCHIVE_URL } else { "https://codeload.github.com/$Repository/zip/refs/heads/main" }
$CommitUrl = if ($env:DSH_TAVERN_COMMIT_URL) { $env:DSH_TAVERN_COMMIT_URL } else { "https://api.github.com/repos/$Repository/commits/main" }
$CdnMetadataUrl = if ($env:DSH_TAVERN_CDN_METADATA_URL) { $env:DSH_TAVERN_CDN_METADATA_URL } else { "https://cdn.jsdelivr.net/gh/$Repository@main/dsh-tavern-runtime.json" }
$CdnRootUrl = if ($env:DSH_TAVERN_CDN_ROOT_URL) { $env:DSH_TAVERN_CDN_ROOT_URL.TrimEnd('/') } else { "https://cdn.jsdelivr.net/gh/$Repository" }
$DshRoot = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path ([Environment]::GetFolderPath('UserProfile')) '.dsh' }
$LegacyDshRoot = if ($env:DSH_TAVERN_LEGACY_DSH_HOME) { $env:DSH_TAVERN_LEGACY_DSH_HOME } else { $DshRoot }
if ($InstallHost -eq 'cli') {
  # CLI directory selection: explicit paths and existing installations never prompt.
  $DefaultCliRoot = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.dsh-tavern'
  $CurrentCliRoot = (Get-Location).ProviderPath
  $DshRoot = $env:DSH_TAVERN_CLI_HOME
  if (-not $DshRoot) {
    if ((Test-Path -LiteralPath (Join-Path $CurrentCliRoot 'apps/dsh-tavern/.dsh-tavern-local.json') -PathType Leaf) -or (Test-Path -LiteralPath (Join-Path $CurrentCliRoot '.dsh-tavern-install-root') -PathType Leaf)) { $DshRoot = $CurrentCliRoot }
    elseif ((Test-Path -LiteralPath (Join-Path $DefaultCliRoot 'apps/dsh-tavern/.dsh-tavern-local.json') -PathType Leaf) -or (Test-Path -LiteralPath (Join-Path $DefaultCliRoot '.dsh-tavern-install-root') -PathType Leaf)) { $DshRoot = $DefaultCliRoot }
    else {
      if ([Console]::IsInputRedirected) { throw '无法交互选择安装目录。请设置 DSH_TAVERN_CLI_HOME 后重新运行。' }
      Write-Host "请选择 CLI 安装目录：`n  1. 默认目录：$DefaultCliRoot`n  2. 当前目录：$CurrentCliRoot（回车默认）`n  3. 其他目录"
      Write-Host '程序、运行时和游戏数据存入所选目录；命令入口和包管理器缓存可能位于目录外。'
      while (-not $DshRoot) {
        $Choice = Read-Host '请选择 [1/2/3，默认 2]'
        switch ($Choice) {
          '1' { $DshRoot = $DefaultCliRoot }
          '2' { $DshRoot = $CurrentCliRoot }
          '' { $DshRoot = $CurrentCliRoot }
          '3' {
            $SelectedCliRoot = Read-Host '请输入完整安装路径'
            if ($SelectedCliRoot -match '^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)') { $DshRoot = $SelectedCliRoot }
            else { Write-Host '请输入完整路径，例如 D:\Games\dsh-tavern。' }
          }
          default { Write-Host '请输入 1、2 或 3。' }
        }
      }
    }
  }
  $DshRoot = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($DshRoot)
  $WindowsRoot = [IO.Path]::GetFullPath($env:WINDIR).TrimEnd('\')
  if ($DshRoot.TrimEnd('\') -ieq $WindowsRoot -or $DshRoot.StartsWith($WindowsRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw "不能将酒馆安装到 Windows 系统目录：$DshRoot。请重新运行并选择其他目录，例如 D:\Games\dsh-tavern。"
  }
  if (-not (Test-Path -LiteralPath (Join-Path $DshRoot 'apps/dsh-tavern/.dsh-tavern-local.json') -PathType Leaf) -and -not (Test-Path -LiteralPath (Join-Path $DshRoot '.dsh-tavern-install-root') -PathType Leaf)) {
    foreach ($Entry in @('apps', 'runtime', 'tools', 'profiles', 'profile-data', 'source-cache', 'logs', 'backups', 'settings.yaml')) {
      if (Test-Path -LiteralPath (Join-Path $DshRoot $Entry)) { throw "安装目录存在冲突：$DshRoot\$Entry。请选择空目录，或使用原有安装目录。" }
    }
  }
  Write-Host "CLI 安装目录：$DshRoot"
  New-Item -ItemType Directory -Force -Path $DshRoot | Out-Null
  Set-Content -LiteralPath (Join-Path $DshRoot '.dsh-tavern-install-root') -Value 'cli-v1'
}

$AppDir = if ($env:DSH_TAVERN_APP_DIR) { $env:DSH_TAVERN_APP_DIR } else { Join-Path $DshRoot 'apps\dsh-tavern' }
$RuntimeRoot = Join-Path $DshRoot 'tools'
$PnpmVersion = '11.25.0'
$CommandBin = Join-Path $DshRoot 'bin'
$SourceCache = Join-Path $DshRoot 'source-cache\dsh-tavern.git'
$TempDir = Join-Path ([IO.Path]::GetTempPath()) ("dsh-tavern-install-" + [Guid]::NewGuid().ToString('N'))
$TargetCommit = if ($env:DSH_TAVERN_TARGET_COMMIT) { $env:DSH_TAVERN_TARGET_COMMIT } else { '' }
$RuntimePaths = @(
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'cordis.patch.yml',
  'install.ps1',
  'install.sh',
  'bin',
  'config',
  'presets',
  'patches',
  'tavern-plugin'
)

# Machine-readable progress for the Windows launcher; also useful in terminals.
function Write-InstallStatus([string]$Message) { Write-Host ("DSH_STATUS " + $Message) }

function Test-Command([string]$Name) {
  return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Resolve-Command([string]$Name) {
  $WindowsShim = Get-Command "$Name.cmd" -ErrorAction SilentlyContinue
  if ($null -ne $WindowsShim) { return $WindowsShim.Source }
  $Command = Get-Command $Name -ErrorAction SilentlyContinue
  if ($null -ne $Command) { return $Command.Source }
  return $null
}

function Assert-LastCommand([string]$Message) {
  if ($LASTEXITCODE -ne 0) { throw $Message }
}

function Invoke-SourceDownload([string]$Uri, [string]$Destination, [int]$TimeoutSec = 300) {
  # PowerShell 5.1's .NET sockets can be blocked while curl/Node still work.
  # Only publish a completed download; a failed transport must not leave bytes behind.
  $Partial = $Destination + '.download-' + [Guid]::NewGuid().ToString('N')
  $PreviousPreference = $ErrorActionPreference
  try {
    $Downloaded = $false
    $CurlCommand = Resolve-Command 'curl.exe'
    if ($null -ne $CurlCommand) {
      $ErrorActionPreference = 'Continue'
      $CurlOutput = & $CurlCommand --fail --location --silent --show-error --connect-timeout 20 --max-time $TimeoutSec --output $Partial --url $Uri 2>&1
      $Downloaded = ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $Partial -PathType Leaf))
      $ErrorActionPreference = $PreviousPreference
    }
    if (-not $Downloaded) {
      $DownloadScript = @'
const fs = require('node:fs');
const { pipeline } = require('node:stream/promises');
const [url, destination, timeout] = process.argv.slice(2);
(async () => {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(Number(timeout) * 1000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  await pipeline(response.body, fs.createWriteStream(destination));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
'@
      $ErrorActionPreference = 'Continue'
      $NodeOutput = $DownloadScript | & node - $Uri $Partial $TimeoutSec 2>&1
      $NodeCode = $LASTEXITCODE
      $ErrorActionPreference = $PreviousPreference
      if ($NodeCode -ne 0) { throw "下载失败，Node 退出码 ${NodeCode}：$($NodeOutput -join "`n")" }
    }
    Move-Item -LiteralPath $Partial -Destination $Destination -Force
  }
  finally {
    $ErrorActionPreference = $PreviousPreference
    if (Test-Path -LiteralPath $Partial) { Remove-Item -LiteralPath $Partial -Force }
  }
}

$PreviousDshHome = $env:DSH_HOME
$PreviousCliHome = $env:DSH_TAVERN_CLI_HOME
$PreviousLegacyHome = $env:DSH_TAVERN_LEGACY_DSH_HOME
$PreviousPath = $env:Path
$PreviousUpdateAttempt = $env:DSH_TAVERN_UPDATE_ATTEMPT
$PreviousNpmRegistry = $env:npm_config_registry
$PreviousPnpmRegistry = $env:pnpm_config_registry
$PreviousPnpmUpdateNotifier = $env:pnpm_config_update_notifier
try {
  [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
  $OutputEncoding = [Console]::OutputEncoding
  $env:DSH_HOME = $DshRoot
  if ($InstallHost -eq 'cli') {
    $env:DSH_TAVERN_CLI_HOME = $DshRoot
    $env:DSH_TAVERN_LEGACY_DSH_HOME = $LegacyDshRoot
  }
  # Child npm/pnpm processes, including Profile and plugin installs, inherit this.
  $env:npm_config_registry = if ($env:DSH_TAVERN_NPM_REGISTRY) { $env:DSH_TAVERN_NPM_REGISTRY } else { 'https://registry.npmmirror.com' }
  # pnpm 11 reads pnpm_config_* instead of npm_config_*.
  $env:pnpm_config_registry = $env:npm_config_registry
  # A pending optional version check can keep pnpm alive after it prints Done.
  $env:pnpm_config_update_notifier = 'false'
  if (-not (Test-Command 'node')) {
    Start-Process 'https://nodejs.org/'
    throw '未找到 Node.js。请安装 Node.js 22.19 或更高版本，然后重新运行本命令。'
  }

  $NodeVersionText = (& node --version).Trim()
  $NodeVersion = [version]$NodeVersionText.TrimStart('v')
  if ($NodeVersion -lt [version]'22.19.0') {
    throw "Node.js 版本过低，需要 22.19 或更高版本（当前：$NodeVersionText）。"
  }
  $GitCommand = Resolve-Command 'git'
  $NpmCommand = Resolve-Command 'npm'
  if ($InstallHost -eq 'cli' -and $null -eq $NpmCommand) { throw '未找到 npm，请重新安装 Node.js。' }

  if ($InstallHost -eq 'cli') {
    $env:Path = "$RuntimeRoot;$env:Path"
    $env:DSH_TAVERN_BIN_DIR = $CommandBin
    $env:Path = "$CommandBin;$env:Path"
    $UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $UserEntries = @($UserPath -split ';' | Where-Object { $_ -ne '' })
    if (-not ($UserEntries | Where-Object { $_.TrimEnd('\') -ieq $CommandBin.TrimEnd('\') })) {
      $NewUserPath = (@($UserEntries) + $CommandBin) -join ';'
      [Environment]::SetEnvironmentVariable('Path', $NewUserPath, 'User')
    }
  }

  New-Item -ItemType Directory -Force -Path $TempDir | Out-Null
  $UpdateLogRoot = if ($env:DSH_TAVERN_UPDATE_LOG_ROOT) { $env:DSH_TAVERN_UPDATE_LOG_ROOT } else { Join-Path $DshRoot 'profile-data/tavern/data' }
  $UpdateAttempt = if ($env:DSH_TAVERN_UPDATE_ATTEMPT) { $env:DSH_TAVERN_UPDATE_ATTEMPT } else { "install-$PID-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())" }
  $env:DSH_TAVERN_UPDATE_ATTEMPT = $UpdateAttempt
  $UpdateLogger = Join-Path $TempDir 'update-log.cjs'
  [IO.File]::WriteAllText($UpdateLogger, @'
const fs=require('node:fs'),path=require('node:path');
try {
 const [root,event,step,exitCode,startedAt,file]=process.argv.slice(2).map(v=>v==='-'?'':v);
 const clean=value=>String(value||'').replace(/https?:\/\/[^\s<>"')]+/g,raw=>{try{const u=new URL(raw);return u.origin+u.pathname}catch{return '[URL]'}}).replace(/Bearer\s+[^\s,;]+/gi,'Bearer [redacted]').replace(/((?:authorization|token|password|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi,'$1[redacted]');
 let output=file&&fs.existsSync(file)?clean(fs.readFileSync(file,'utf8')):'';
 const outputCharacters=output.length;
 if(output.length>6000)output=output.slice(0,3000)+'\n[中间输出省略]\n'+output.slice(-3000);
 const record={at:new Date().toISOString(),pid:process.ppid,attemptId:process.env.DSH_TAVERN_UPDATE_ATTEMPT,event,step,exitCode:exitCode===''?undefined:Number(exitCode),durationMs:startedAt?Date.now()-Number(startedAt):undefined,output,outputCharacters};
 fs.mkdirSync(root,{recursive:true});const target=path.join(root,'update-diagnostics.jsonl');
 try{if(fs.statSync(target).size>1048576){try{fs.unlinkSync(target+'.1')}catch{}fs.renameSync(target,target+'.1')}}catch{}
 fs.appendFileSync(target,JSON.stringify(record)+'\n');
}catch{process.exitCode=1}
'@, (New-Object Text.UTF8Encoding($false)))
  function Write-UpdateLog([string]$Event, [string]$Step, [string]$Code = '', [string]$Started = '', [string]$OutputFile = '') {
    try {
      $LogArgs = @($UpdateLogRoot, $Event, $Step, $Code, $Started, $OutputFile) | ForEach-Object { if ($_ -eq '') { '-' } else { $_ } }
      & node $UpdateLogger @LogArgs *> $null
      if ($LASTEXITCODE -eq 0) { return }
    } catch {}
    # Logging must still work when the Desktop Node shim itself is broken.
    try {
      $Text = if ($OutputFile -and (Test-Path -LiteralPath $OutputFile)) { [IO.File]::ReadAllText($OutputFile) } else { '' }
      $Text = [regex]::Replace($Text, 'https?://[^\s<>"'')]+', { param($m) try { $u = [Uri]$m.Value; $u.GetLeftPart([UriPartial]::Authority) -replace '://[^/]*@', '://' } catch { '[URL]' } })
      $Text = $Text -replace '(?i)Bearer\s+[^\s,;]+', 'Bearer [redacted]' -replace '(?i)((?:authorization|token|password|api[_-]?key)\s*[:=]\s*)[^\s,;]+', '$1[redacted]'
      $Count = $Text.Length
      if ($Count -gt 6000) { $Text = $Text.Substring(0,3000) + "`n[中间输出省略]`n" + $Text.Substring($Count-3000) }
      $Record = @{ at = [DateTime]::UtcNow.ToString('o'); attemptId = $env:DSH_TAVERN_UPDATE_ATTEMPT; event = $Event; step = $Step; output = $Text; outputCharacters = $Count }
      if ($Code -ne '') { $Record.exitCode = [int]$Code }
      if ($Started -ne '') { $Record.durationMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [long]$Started }
      New-Item -ItemType Directory -Force -Path $UpdateLogRoot | Out-Null
      $LogPath = Join-Path $UpdateLogRoot 'update-diagnostics.jsonl'
      if ((Test-Path -LiteralPath $LogPath) -and (Get-Item -LiteralPath $LogPath).Length -gt 1048576) { Move-Item -LiteralPath $LogPath -Destination "$LogPath.1" -Force }
      [IO.File]::AppendAllText($LogPath, (($Record | ConvertTo-Json -Compress) + "`n"), (New-Object Text.UTF8Encoding($false)))
    } catch { Write-Warning "诊断日志写入失败：$($_.Exception.Message)" }
  }
  function Assert-InstallFiles([string]$Root) {
    foreach ($Relative in @('package.json', 'pnpm-lock.yaml', 'bin\dsh-compatibility.mjs', 'bin\dsh-tavern.mjs', 'bin\desktop-package-manager.mjs', 'config\dsh-compatibility.json')) {
      $Required = Join-Path $Root $Relative
      if (-not (Test-Path -LiteralPath $Required -PathType Leaf)) { throw "安装文件不完整，缺少：$Required" }
    }
  }
  function Invoke-UpdateGit([string]$Step, [string[]]$GitArgs) {
    $Started = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $GitStatus = switch ($Step) { 'git.clone' { '下载代码：首次获取 GitHub 运行代码…' } 'git.fetch' { '下载代码：正在同步 GitHub 最新版本…' } 'git.archive' { '下载代码：正在准备 Git 运行文件…' } default { '下载代码：正在检查 Git 源…' } }
    Write-InstallStatus $GitStatus
    Write-UpdateLog 'installer.stage.started' $Step
    $PreviousPreference = $ErrorActionPreference
    $Output = @()
    $Code = 1
    try {
      $ErrorActionPreference = 'Continue'
      $LastGitProgress = ''
      $Output = @(& $GitCommand -c http.lowSpeedLimit=1024 -c http.lowSpeedTime=30 @GitArgs 2>&1 | ForEach-Object {
        $GitLine = [string]$_
        if ($GitLine -match '(Receiving objects|Resolving deltas):\s+(\d+)%') {
          $GitProgress = if ($Matches[1] -eq 'Receiving objects') { "GitHub 接收文件：$($Matches[2])%（当前步骤）" } else { "Git 整理文件：$($Matches[2])%（当前步骤）" }
          if ($GitProgress -ne $LastGitProgress) { Write-InstallStatus $GitProgress; $LastGitProgress = $GitProgress }
        }
        $_
      })
      $Code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $PreviousPreference }
    $OutputFile = Join-Path $TempDir 'git.output'
    [IO.File]::WriteAllText($OutputFile, ($Output -join "`n"), (New-Object Text.UTF8Encoding($false)))
    $Event = if ($Code -eq 0) { 'installer.stage.succeeded' } else { 'installer.stage.failed' }
    Write-UpdateLog $Event $Step ([string]$Code) ([string]$Started) $OutputFile
    if ($Code -ne 0) { throw "Git 步骤失败：$Step（退出码 $Code）：$($Output -join "`n")" }
    return ($Output -join "`n")
  }
  function Invoke-InstallCommand([string]$Step, [string]$Command, [string[]]$CommandArgs, [switch]$CaptureOutput) {
    $Started = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    Write-UpdateLog 'installer.stage.started' $Step
    $OutputFile = Join-Path $TempDir 'command.output'
    $ErrorFile = Join-Path $TempDir 'command.error'
    [IO.File]::WriteAllText($OutputFile, '')
    [IO.File]::WriteAllText($ErrorFile, '')
    $PreviousPreference = $ErrorActionPreference
    $Code = 1
    $InvocationError = ''
    try {
      $ErrorActionPreference = 'Continue'
      & $Command @CommandArgs 2>&1 | ForEach-Object {
        $Line = [string]$_
        if ($_ -is [System.Management.Automation.ErrorRecord]) {
          [IO.File]::AppendAllText($ErrorFile, "$Line`n")
          Write-Host $Line
        } else {
          [IO.File]::AppendAllText($OutputFile, "$Line`n")
          if (-not $CaptureOutput) { Write-Host $Line }
        }
      }
      $Code = $LASTEXITCODE
    } catch { $InvocationError = $_.Exception.ToString() }
    finally { $ErrorActionPreference = $PreviousPreference }
    $Stdout = if (Test-Path $OutputFile) { [IO.File]::ReadAllText($OutputFile) } else { '' }
    $Stderr = if (Test-Path $ErrorFile) { [IO.File]::ReadAllText($ErrorFile) } else { '' }
    $Combined = "$Stdout`n$Stderr`n$InvocationError".Trim()
    [IO.File]::WriteAllText($OutputFile, $Combined, (New-Object Text.UTF8Encoding($false)))
    $Event = if ($Code -eq 0) { 'installer.stage.succeeded' } else { 'installer.stage.failed' }
    Write-UpdateLog $Event $Step ([string]$Code) ([string]$Started) $OutputFile
    if ($Code -ne 0) {
      throw "步骤 $Step 失败（退出码 $Code）。`n$Combined`n诊断日志：$UpdateLogRoot/update-diagnostics.jsonl"
    }
    if ($CaptureOutput) { return $Stdout.Trim() }
  }
  Write-UpdateLog 'installer.started' 'bootstrap'
  Write-Host "更新诊断日志：$UpdateLogRoot/update-diagnostics.jsonl"
  $ArchivePath = Join-Path $TempDir 'app.zip'
  $ExtractDir = Join-Path $TempDir 'extract'
  $UsedGit = $false
  $UsedCdn = $false
  if ($null -ne $GitCommand) {
    try {
      Write-InstallStatus '下载代码：正在连接 GitHub，使用 Git 增量同步…'
      New-Item -ItemType Directory -Force -Path (Split-Path $SourceCache -Parent) | Out-Null
      if (-not (Test-Path (Join-Path $SourceCache 'HEAD'))) {
        Invoke-UpdateGit 'git.clone' @('clone', '--progress', '--bare', '--filter=blob:none', '--depth', '1', '--single-branch', '--branch', 'main', $RepositoryUrl, $SourceCache) | Write-Host
      }
      Invoke-UpdateGit 'git.remote' @("--git-dir=$SourceCache", 'remote', 'set-url', 'origin', $RepositoryUrl) | Write-Host
      Invoke-UpdateGit 'git.fetch' @("--git-dir=$SourceCache", 'fetch', '--progress', '--depth', '1', 'origin', 'main') | Write-Host
      $TargetCommit = (Invoke-UpdateGit 'git.revision' @("--git-dir=$SourceCache", 'rev-parse', 'FETCH_HEAD')).Trim()
      Invoke-UpdateGit 'git.archive' (@('-c', 'core.autocrlf=false', '-c', 'core.eol=lf', "--git-dir=$SourceCache", 'archive', '--format=zip', "--output=$ArchivePath", 'FETCH_HEAD', '--') + $RuntimePaths) | Write-Host
      $UsedGit = $true
    }
    catch {
      Write-InstallStatus 'GitHub 同步失败或连接过慢，正在切换 jsDelivr 备用源；详细原因见日志。'
      Write-Warning ("Git 增量更新失败，正在尝试 jsDelivr 备用源：" + $_.Exception.Message)
    }
  }
  if ($null -eq $GitCommand) { Write-UpdateLog 'installer.stage.failed' 'git.unavailable' '127'; Write-Warning '未找到 Git，正在尝试备用源。' }
  if (-not $UsedGit) {
    try {
      Write-InstallStatus '下载代码：正在连接 jsDelivr 备用源…'
      Write-UpdateLog 'installer.stage.started' 'source.jsdelivr'
      $CdnSource = Join-Path $TempDir 'cdn-source'
      New-Item -ItemType Directory -Force -Path $CdnSource | Out-Null
      $MetadataPath = Join-Path $TempDir 'cdn-metadata.json'
      Invoke-SourceDownload $CdnMetadataUrl $MetadataPath 15
      $Metadata = [IO.File]::ReadAllText($MetadataPath) | ConvertFrom-Json
      if ([string]$Metadata.revision -notmatch '^[0-9a-fA-F]{40}$') { throw 'jsDelivr 运行清单缺少有效提交号。' }
      $RuntimePattern = '^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|cordis\.patch\.yml|install\.ps1|install\.sh|bin/|config/|presets/|patches/|tavern-plugin/)'
      $Files = @($Metadata.files | Where-Object { $_.path -match $RuntimePattern -and $_.path -notmatch '(^|/)(\.\.|docs|tests|__tests__|testsets)(/|$)' -and $_.sha256 -match '^[0-9a-fA-F]{64}$' })
      if ($Files.Count -eq 0) { throw 'jsDelivr 未返回运行文件清单。' }
      $DownloadManifest = Join-Path $TempDir 'download-manifest.json'
      [IO.File]::WriteAllText($DownloadManifest, (@{ revision = $Metadata.revision; files = @($Files) } | ConvertTo-Json -Depth 10), (New-Object Text.UTF8Encoding($false)))
      $CdnDownloader = Join-Path $TempDir 'cdn-download.cjs'
      [IO.File]::WriteAllText($CdnDownloader, @'
const fs=require('node:fs/promises');
const path=require('node:path');
const {createHash}=require('node:crypto');
const [manifest,base,destination,installed]=process.argv.slice(2);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const status=message=>console.log('DSH_STATUS '+message);
const controller=new AbortController();
(async()=>{
 const metadata=JSON.parse(await fs.readFile(manifest,'utf8'));
 const files=metadata.files;
 if(!/^[a-f0-9]{40}$/i.test(metadata.revision)||!Array.isArray(files)||!files.length)throw Error('无效下载清单');
 for(const file of files)if(typeof file.path!=='string'||file.path.includes('\\')||file.path.includes(':')||file.path.split('/').some(p=>!p||p==='.'||p==='..')||!/^[a-f0-9]{64}$/i.test(file.sha256))throw Error('无效文件路径或校验值');
 let next=0,done=0,reused=0,bytes=0;
 const source=new URL(base).hostname;
 const report=()=>status(`下载代码（${source}）：${done}/${files.length} 文件，复用 ${reused}，已下载 ${(bytes/1048576).toFixed(1)} MB`);
 report();
 await Promise.all(Array.from({length:Math.min(6,files.length)},async()=>{
  while(next<files.length&&!controller.signal.aborted){
   const file=files[next++],target=path.join(destination,...file.path.split('/'));
   let content;
   try {const local=await fs.readFile(path.join(installed,...file.path.split('/')));if(hash(local)===file.sha256.toLowerCase()){content=local;reused++;}}catch{}
   if(!content)for(let attempt=1;attempt<=2;attempt++){
    try {
     const response=await fetch(`${base}@${metadata.revision}/${file.path.split('/').map(encodeURIComponent).join('/')}`,{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(30000)])});
     if(!response.ok)throw Error(`HTTP ${response.status}`);
     content=Buffer.from(await response.arrayBuffer());
     if(hash(content)!==file.sha256.toLowerCase())throw Error('文件校验不符');
     bytes+=content.length;break;
    }catch(error){
     if(controller.signal.aborted)throw error;
     const reason=error.name==='TimeoutError'?'请求超过 30 秒未完成':String(error.cause?.code||error.message);
     status(`下载失败（${source}）：${file.path}，${reason}；尝试 ${attempt}/2${attempt<2?'，正在重试':'，将切换备用方案'}。`);
     if(attempt===2){controller.abort();throw Error(`下载失败：${file.path}（${reason}）`);}
    }
   }
   if(controller.signal.aborted)return;
   await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,content);done++;report();
  }
 }));
})().catch(error=>{controller.abort();console.error(error.message);process.exitCode=1});
'@, (New-Object Text.UTF8Encoding($false)))
      Invoke-InstallCommand 'source.files' 'node' @($CdnDownloader, $DownloadManifest, $CdnRootUrl, $CdnSource, $AppDir)
      [IO.File]::WriteAllText((Join-Path $CdnSource 'dsh-tavern-runtime.json'), (($Metadata | ConvertTo-Json -Depth 10) + [Environment]::NewLine), (New-Object Text.UTF8Encoding($false)))
      $TargetCommit = [string]$Metadata.revision
      Write-UpdateLog 'installer.stage.succeeded' 'source.jsdelivr' '0'
      $UsedCdn = $true
    }
    catch {
      $CdnErrorFile = Join-Path $TempDir 'cdn.error'
      [IO.File]::WriteAllText($CdnErrorFile, $_.Exception.ToString(), (New-Object Text.UTF8Encoding($false)))
      Write-UpdateLog 'installer.stage.failed' 'source.jsdelivr' '1' '' $CdnErrorFile
      Write-InstallStatus 'jsDelivr 下载失败，正在切换 GitHub 压缩包；详细原因见日志。'
      Write-Warning ("jsDelivr 备用源不可用，将回退到精简运行压缩包：" + $_.Exception.Message)
    }
  }
  if (-not $UsedGit -and -not $UsedCdn) {
    Write-InstallStatus '下载代码：前面的源不可用，正在尝试 GitHub 压缩包…'
    $PreviousProgressPreference = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'
    try {
      if ($TargetCommit -eq '') {
        try {
          $CommitPath = Join-Path $TempDir 'commit.json'
          Invoke-SourceDownload $CommitUrl $CommitPath 15
          $TargetCommit = ([IO.File]::ReadAllText($CommitPath) | ConvertFrom-Json).sha
        }
        catch { Write-Warning '无法记录当前提交号，不影响本次安装。' }
      }
      for ($Attempt = 1; $Attempt -le 3; $Attempt++) {
        try {
          Invoke-SourceDownload $ArchiveUrl $ArchivePath 120
          break
        }
        catch {
          if ($Attempt -eq 3) { throw }
          Write-InstallStatus "压缩包下载失败，2 秒后重试（已尝试 $Attempt/3）；请检查网络或查看日志。"
          Start-Sleep -Seconds 2
        }
      }
    }
    finally {
      $ProgressPreference = $PreviousProgressPreference
    }
  }
  if (-not $UsedCdn) {
    New-Item -ItemType Directory -Force -Path $ExtractDir | Out-Null
    Write-InstallStatus '本地处理：下载完成，正在解压运行文件…'
    Expand-Archive -LiteralPath $ArchivePath -DestinationPath $ExtractDir -Force
    # Only the temporary download is pruned; never remove installed user files.
    @(Get-ChildItem -LiteralPath $ExtractDir -Directory -Recurse -Filter 'docs') |
      Sort-Object { $_.FullName.Length } -Descending |
      ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force }
  }
  Write-InstallStatus '本地处理：正在校验安装文件…'
  $SourceDir = if ($UsedCdn) {
    Get-Item -LiteralPath $CdnSource
  } elseif ($UsedGit) {
    Get-Item -LiteralPath $ExtractDir
  } else {
    Get-ChildItem -LiteralPath $ExtractDir -Directory | Select-Object -First 1
  }
  if ($null -eq $SourceDir) { throw '下载内容不完整。' }
  if (-not (Test-Path (Join-Path $SourceDir.FullName 'package.json'))) {
    throw '下载内容不完整。'
  }
  Assert-InstallFiles $SourceDir.FullName

  # Read compatibility from the downloaded release before installing missing tools.
  $CompatibilityScript = Join-Path $SourceDir.FullName 'bin\dsh-compatibility.mjs'
  $AdaptedDshVersion = (& node $CompatibilityScript --version)
  Assert-LastCommand '读取 DSH 适配版本失败。'
  $AdaptedDshVersion = $AdaptedDshVersion.Trim()
  & node $CompatibilityScript --notice $InstallHost
  Assert-LastCommand '读取 DSH 兼容提示失败。'
  $MissingPackages = @()
  $PnpmCommand = Resolve-Command 'pnpm'
  $PnpmNeedsInstall = $false
  if ($InstallHost -eq 'cli') {
    if ($null -eq $PnpmCommand) {
      $PnpmNeedsInstall = $true
    }
    else {
      try { $PnpmNeedsInstall = ((& $PnpmCommand --version).Trim() -ne $PnpmVersion) }
      catch { $PnpmNeedsInstall = $true }
    }
  }
  if ($PnpmNeedsInstall) { $MissingPackages += "pnpm@$PnpmVersion" }
  if ($MissingPackages.Count -gt 0) {
    Write-Host ("正在安装缺失依赖：" + ($MissingPackages -join '、') + '……')
    New-Item -ItemType Directory -Force -Path $RuntimeRoot | Out-Null
    & $NpmCommand install --global --prefix $RuntimeRoot @MissingPackages
    Assert-LastCommand 'pnpm 或 DeepSeek Harness 安装失败。'
  }
  $PnpmCommand = Resolve-Command 'pnpm'
  if ($null -eq $PnpmCommand) { throw '未找到 pnpm。Desktop 版请从 DSH Desktop 托盘打开 DSH Terminal 后运行本命令。' }
  $DshCommand = Resolve-Command 'dsh'
  if ($InstallHost -ne 'cli' -and $null -eq $DshCommand) { throw '未找到 DSH。Desktop 版请从 DSH Desktop 托盘打开 DSH Terminal 后运行本命令。' }

  # Validate before replacing any installed application files.
  if ($InstallHost -ne 'cli') {
    $CurrentDshVersion = (& $DshCommand --version)
    Assert-LastCommand '无法读取宿主 DSH 版本。'
    & node $CompatibilityScript --check $InstallHost ($CurrentDshVersion -join "`n")
    Assert-LastCommand '宿主 DSH 版本不兼容，尚未覆盖程序文件。'
  }

  $OldLauncher = Join-Path $AppDir 'bin\dsh-tavern.mjs'
  if ($InstallHost -eq 'cli' -and (Test-Path $OldLauncher)) {
    & node $OldLauncher stop *> $null
  }

  Write-InstallStatus '本地处理：正在更新程序文件，保留用户数据…'
  New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
  # 覆盖程序文件但不删除旧目录，因此未被发布包跟踪的 data\ 用户数据会保留。
  Get-ChildItem -LiteralPath $SourceDir.FullName -Force | Copy-Item -Destination $AppDir -Recurse -Force
  Assert-InstallFiles $AppDir
  $PathsFile = Join-Path $TempDir 'install-paths.txt'
  [IO.File]::WriteAllText($PathsFile, "Host=$InstallHost`nDSH_HOME=$DshRoot`nAppDir=$AppDir`nSource=$($SourceDir.FullName)`nCommit=$TargetCommit`nNode=$((Get-Command node).Source)", (New-Object Text.UTF8Encoding($false)))
  Write-UpdateLog 'installer.paths' 'files.copy' '0' '' $PathsFile
  if ($UsedCdn -and (Test-Path (Join-Path $AppDir '.dsh-tavern-release.json'))) {
    Remove-Item -LiteralPath (Join-Path $AppDir '.dsh-tavern-release.json') -Force
  }
  if ($TargetCommit -match '^[0-9a-fA-F]{40}$') {
    $ReleaseJson = @{ commit = $TargetCommit; installedAt = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json
    [IO.File]::WriteAllText((Join-Path $AppDir '.dsh-tavern-release.json'), $ReleaseJson, (New-Object Text.UTF8Encoding($false)))
  }

  if ($InstallHost -eq 'desktop') {
    Write-InstallStatus '准备依赖：正在检查 Windows Desktop 包管理环境…'
    $PackageManagerBin = Invoke-InstallCommand 'desktop.package-manager' 'node' @((Join-Path $AppDir 'bin\desktop-package-manager.mjs')) -CaptureOutput
    $PackageManagerBin = ($PackageManagerBin -join "`n").Trim()
    if (-not (Test-Path -LiteralPath (Join-Path $PackageManagerBin 'pnpm.cmd'))) { throw 'Desktop 包管理入口未生成。' }
    $env:Path = "$PackageManagerBin;$env:Path"
    $PnpmCommand = Join-Path $PackageManagerBin 'pnpm.cmd'
  }
  Write-InstallStatus '安装依赖：正在连接软件包仓库，已有缓存将直接复用…'
  Invoke-InstallCommand 'dependencies.install' $PnpmCommand @('--dir', $AppDir, 'install', '--frozen-lockfile', '--reporter=append-only', '--fetch-timeout=30000', '--fetch-retries=2', '--fetch-retry-mintimeout=1000', '--fetch-retry-maxtimeout=5000')

  Write-InstallStatus '本地配置：正在注册 Tavern 并检查兼容性…'
  Invoke-InstallCommand 'profile.install' 'node' @((Join-Path $AppDir 'bin\dsh-tavern.mjs'), 'install', '--host', $InstallHost)
  if ($InstallHost -eq 'desktop') {
    Write-Host 'DSH Tavern Desktop 版安装完成。'
    Write-Host '请重启 DSH Desktop，再从托盘的 Profile 菜单切换到 tavern。'
  }
  else {
    Invoke-InstallCommand 'service.start' 'node' @((Join-Path $AppDir 'bin\dsh-tavern.mjs'), 'start')
    Write-Host 'DSH Tavern 安装完成。请使用上方完整访问地址，或运行 dsh-tavern open 打开网页。'
    Write-Host '以后可以使用：dsh-tavern start、open、stop、restart、status、update（新 PowerShell 生效）'
  }
  Write-UpdateLog 'installer.finished' 'bootstrap' '0'
}
catch {
  $InstallFailure = $_
  try {
    if (Test-Path $UpdateLogger) {
      $FailureFile = Join-Path $TempDir 'installer.error'
      [IO.File]::WriteAllText($FailureFile, $InstallFailure.Exception.ToString(), (New-Object Text.UTF8Encoding($false)))
      Write-UpdateLog 'installer.finished' 'bootstrap' '1' '' $FailureFile
    }
  } catch {}
  if ($UpdateLogRoot) { Write-Host "安装失败，请提供诊断日志：$UpdateLogRoot/update-diagnostics.jsonl" }
  throw ("安装失败：" + $InstallFailure.Exception.Message)
}
finally {
  [Console]::OutputEncoding = $PreviousConsoleOutputEncoding
  $OutputEncoding = $PreviousOutputEncoding
  $env:npm_config_registry = $PreviousNpmRegistry
  $env:pnpm_config_registry = $PreviousPnpmRegistry
  $env:pnpm_config_update_notifier = $PreviousPnpmUpdateNotifier
  $env:DSH_HOME = $PreviousDshHome
  $env:DSH_TAVERN_CLI_HOME = $PreviousCliHome
  $env:DSH_TAVERN_LEGACY_DSH_HOME = $PreviousLegacyHome
  $env:Path = $PreviousPath
  $env:DSH_TAVERN_UPDATE_ATTEMPT = $PreviousUpdateAttempt
  if (Test-Path $TempDir) {
    Remove-Item -LiteralPath $TempDir -Recurse -Force
  }
}
