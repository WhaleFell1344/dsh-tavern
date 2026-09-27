# SQLite 跨平台接入验证（2026-09-27）

## 结论与边界

同一份零依赖 `node:sqlite` 探针，在 macOS CLI（含最低 Node 22.19.0）、macOS Desktop 2.0.13、Android 12 模拟器内的 DSHA 标准版与独立 Tavern APK 上通过。数据库操作没有按平台分支，也没有安装 SQLite 驱动或数据库服务。

**尚未完成所有当前支持平台的验证。** Windows CLI、Windows Desktop / 一键安装包、独立 Linux / WSL2、macOS Intel、旧 Android 上的 DSHA low 均没有本次实测结果。Android 结果来自 MuMu ARM64 模拟器，不代表真机已通过。不能将 Android 容器中的 `process.platform=linux` 计作独立 Linux 验收。

本次验证运行时能执行共同的 SQLite API 和基础持久化语义，不修改 Tavern 正式存储，不验证真实聊天迁移、性能、整机断电、Android 系统杀后台或完整 DSH 插件加载生命周期。

## 当前支持范围的依据

- `docs/installation.md`：CLI 为 Windows / macOS / Linux（包括 WSL2），最低 Node 22.19；Desktop 固定 2.0.13；DSHA 固定 0.1.5-rc2，另有旧 Android low 包；独立 APK 要求 Android 11+ ARM64。
- CLI 的独立 DSH 版本不等于独立 Node；Node 仍来自系统。
- [Desktop v2.0.13 的包配置](https://github.com/anywhere-labs/dsh-desktop/blob/v2.0.13/dsh-plugin-desktop/package.json) 固定 Electron 43.3.0。Windows 包管理用的 Node 22.22.3 **不是**运行 Tavern 的 Electron Node，不能用前者测试结果代替后者。
- [DSHA v0.1.5-rc2 的构建配置](https://github.com/DSH-APP/DSHA/blob/v0.1.5-rc2/app/build.gradle) 中 standard 和 low 共用基础资产，但 low 使用不同 Android 兼容配置与原生运行组件，标准版成功不能代替 low 实测。
- `android/apk/prepare.py` 锁定并复用官方 APK 资产。此次安装的 DSHA 与独立 APK 都报告 `versionName=0.1.5-rc2`。

## 已执行结果

| 环境 | Node | Electron | SQLite | 结果 |
| --- | --- | --- | --- | --- |
| macOS ARM64 CLI 最低版本 | 22.19.0 | — | 3.50.4 | 9 项通过 |
| macOS ARM64 当前 CLI | 22.22.0 | — | 3.50.4 | 9 项通过 |
| 本机 Desktop 2.0.13 自带可执行文件 | 24.18.1 | 43.3.0 | 3.53.1 | 9 项通过 |
| Android 12 ARM64 / DSHA 标准版容器 | 24.19.0 | — | 3.53.3 | 9 项通过 |
| Android 12 ARM64 / 独立 Tavern APK 容器 | 24.19.0 | — | 3.53.3 | 9 项通过 |

探针：`tests/fixtures/sqlite-platform-probe.cjs`。

机器可读证据：[`2026-09-27-sqlite-platform-results.json`](2026-09-27-sqlite-platform-results.json)。五次运行的脚本 SHA-256 和读取数据 SHA-256 均一致：

- 探针：`889f0576d4fdb2284451239402c54c0e6b8acf5b7e21accd516804c7a97bb802`
- 数据：`b785ae3de25f1846f3bd0e0e4168deea665d655ede3071a5f7f3250dcd1fc000`

最低版本 Node 来自官方 `node-v22.19.0-darwin-arm64.tar.gz`，SHA-256 `c59006db713c770d6ec63ae16cb3edc11f49ee093b5c415d667bb4f436c6526d`，与官方 SHASUMS256.txt 一致。

9 项检查：WAL 文件写入；中文/JSON/BLOB/64 位整数往返；外键约束；事务回滚；跨进程写锁冲突与并行读取；新进程重开后数据保留；已提交 WAL 与未提交事务在进程不关闭数据库直接退出后的恢复；完整性检查；Worker 线程读取。

所有数据库都在新建临时子目录中，完成后删除。未打开、迁移或改写现有聊天数据库。每次执行创建独立数据库；数据哈希一致不等于已经测试了跨平台数据库文件搬迁。

## 复现

普通 CLI：

```sh
node tests/fixtures/sqlite-platform-probe.cjs
```

macOS Desktop（使用已安装程序自带运行时，无须退出正在运行的 Desktop）：

```sh
ELECTRON_RUN_AS_NODE=1 '/Applications/DSH Desktop.app/Contents/MacOS/DSH Desktop' tests/fixtures/sqlite-platform-probe.cjs
```

Windows Desktop 在 PowerShell 中指定实际安装的 exe：

```powershell
$env:ELECTRON_RUN_AS_NODE='1'
& '实际安装路径\DSH Desktop.exe' '探针完整路径\sqlite-platform-probe.cjs'
Remove-Item Env:ELECTRON_RUN_AS_NODE
```

Android：在 DSHA / Tavern APK 自带终端中执行。先将原样探针复制到容器私有目录，再运行：

```sh
node /root/sqlite-platform-probe.cjs /root
```

本次独立 APK 无权读取由 ADB 放入共享 Download 的脚本，最初报 EACCES，尚未进入 SQLite。通过仅本机的 ADB reverse / HTTP 下载同一脚本到 `/root` 后成功；测试数据库也放在 `/root` 下。脚本哈希验证了传输后内容一致。生产数据库应放在宿主 Tavern 私有数据目录，不能直接套用共享 Download 或外接目录的文件锁假设。

## 后续验收与接入约束

1. 新增 `.github/workflows/sqlite-compatibility.yml`，用于 Windows / Ubuntu / macOS 的 Node 22.19.0、24.18.1，以及 Windows / macOS 的 Electron 43.3.0。**本次仅本地编写并检查 YAML，尚未推送或运行 CI。** Electron CI 也不能代替真实安装包、宿主插件加载及用户数据目录的测试。
2. 补 Windows 2.0.13 真实安装包和 DSHA low 旧 Android / 真机结果；具体 CPU 架构须随支持范围覆盖，不能用一台 ARM64 结果代替所有架构。
3. 保持同一 storage 实现：`node:sqlite` 公共 API 子集、同一 schema 和事务规则；明确设置 `foreign_keys`、`busy_timeout`、`synchronous`、`journal_mode`。不要依赖只有新版 Node 或某个 SQLite 编译版本提供的扩展。
4. Node 22 的 SQLite 仍打印 experimental 警告，实测通过不等于上游 API 永久不变。安装/启动检查必须探测真正的宿主运行时能力；缺少能力应明确报告，不静默改成另一套存储语义。
5. `DatabaseSync` 为同步 API；正式接入应评估放入 Worker 的读写队列，避免阻塞服务事件循环。迁移、备份、崩溃恢复、完整聊天数据语义和性能另行验收。

参考：[Node SQLite API](https://nodejs.org/api/sqlite.html)。本次没有新增第三方原生模块依赖，不需要为 Electron 重编译 SQLite 驱动。
