# 超长存档变量结算计时（2026-09-27）

结论：1000 轮合成长档中，从 `mvu_submit_update` 的更新进入结算流程，到最终 commit 返回，3 次实测为 **6.10～12.76 秒，中位数 7.45 秒**。最后 commit 本身仅 **39～45 毫秒**。落盘后状态栏显示另需 **0.51～5.91 秒**，因此只测存储写入会明显低估用户等待时间。

## 环境与边界

- Apple M1、16GB 内存、Node v22.22.0、DSH 0.1.5-rc.2、Playwright Chromium；基于代码 `46b59f1b`。
- 独立临时 Profile，真实 DSH / 原生 Session / 官方 MVU / Remote / React / 状态栏 iframe / Chat journal。只有模型输出固定，没有真实模型或网络服务耗时。
- 真实创建人物卡并结算一轮，再生成 Chat 和原生 Session 对齐的长历史。每轮保留变量快照及重算 baseline。变量从人物卡初始定义进入 MVU，避免临时塞入未知字段被 schema 清除。
- 每组连续重新结算 3 次，每次修改金币并独立新建 journal store 读目标楼，核对金币、全部 20 个合成字段、回执 `updated` 及 `pending=false`。
- 1000 轮共 1999 条消息，逻辑 JSON **47,626,487 字节（45.42 MiB）**；20 轮共 39 条消息，938,619 字节。两组变量快照相同，每份 11,463 字节，21 个顶层字段。大小是展开后的逻辑 JSON，不是压缩文件大小。
- 关闭 Playwright tracing；两组串行运行，运行前已清理失败测试残留服务。探针只注入测试子进程，没有修改生产代码。

## 计时结果

单位毫秒，格式为中位数（最小～最大），每组 n=3。

| 阶段 | 20 轮 | 1000 轮 |
| --- | ---: | ---: |
| 模型变量更新进入结算 → commit 返回 | 492（488～502） | **7448（6098～12756）** |
| 浏览器 MVU 事件完成 → 最终日志 append 完成 | 407（401～411） | **415（415～416）** |
| 浏览器 MVU 事件完成 → commit 返回 | 442（438～444） | 441（439～445） |
| 服务端 runtime 返回 → commit 返回 | 82（80～82） | 79（79～84） |
| 最后 commit 本身 | 50（47～56） | **44（39～45）** |
| commit 返回 → 状态栏显示新金币 | 141（67～204） | **605（506～5907）** |
| 模型变量更新进入结算 → 状态栏显示 | 643（560～692） | **12005（8053～13262）** |

这里“变量更新完成”有两个不同边界：模型已提交更新，与浏览器内官方 MVU 脚本已处理完更新。前者到最终落地仍有秒级工作；后者到日志写入约 0.42 秒。1000 轮主要增长发生在提交后、MVU 事件完成前，而非最后 commit。该区间包含派发、浏览器处理与通信，当前探针不能将它全部归为 MVU 计算。

状态栏显示时间在 iframe 中通过 MutationObserver 加两次 requestAnimationFrame 记录；这是 DOM 更新后的绘制机会，不是屏幕像素采集。1000 轮回执 DOM 更新分别比 commit 晚约 470、500、3665 毫秒。第三次页面尾延迟确实存在，但仅 3 个样本不能据此推断 p95。

日志 append 时间是在真实 `appendFile` 返回后记录，表示操作系统可读的持久化记录；未测 fsync 或断电安全。独立读档验证发生在显示后，其 458～491 毫秒读档开销没有计入上述结算耗时。同机不同进程使用 epoch 时钟，对毫秒级绝对精度不作保证。

## 更重样本与未完成项

- 400 轮、101 个变量字段、72,849,163 字节样本完成 5 次，提交到 commit 为 2.02～2.13 秒，commit 为 35～43 毫秒，显示再等 1.66～7.85 秒。但前段与上一个失败测试的残留服务存在 CPU 竞争，**不纳入上表或用作严格对比**。原始产物：`output/e2e-gameplay/run-YhiP27`。
- 1000 轮、101 个字段、约 170 MiB 的更重样本，开启 tracing 时冷加载超时；关闭 tracing 后进入游戏，但未完成一次可用结算采样。随后测试程序在关闭页面时暴露未处理的 Promise rejection，现已处理，不能将该异常直接判成产品浏览器崩溃。该规模仍无完整耗时结论。
- 对更重样本的服务端采集了 3 秒 CPU profile，96.9% 的采样命中 `freezeJson`，调用链位于 `view → helperMessagesProjection → projectTavernHelperContext`。这提供了长历史投影的排查方向，**不等于已经证明它就是成功样本中某段延迟的唯一原因**。本次未做性能修复。
- 本次是合成存档、重新结算路径；不代表任意真实人物卡、手机设备、首次生成路径或长时间连续游玩的上限。

## 复现与产物

```sh
TAVERN_PERF_ROUNDS=1000 TAVERN_PERF_FIELDS=20 TAVERN_PERF_RUNS=3 TAVERN_E2E_TIMEOUT_MS=120000 node tests/e2e/gameplay.mjs --settlement-performance
TAVERN_PERF_ROUNDS=20 TAVERN_PERF_FIELDS=20 TAVERN_PERF_RUNS=3 TAVERN_E2E_TIMEOUT_MS=120000 node tests/e2e/gameplay.mjs --settlement-performance
```

原始时间戳和阶段事件见 [可复核数据](long-archive-settlement-20260927.json)。完整本地产物：1000 轮 `output/e2e-gameplay/run-T7NHNS`，20 轮 `output/e2e-gameplay/run-D1DnuO`，均有通过报告、服务端日志及截图。失败重样本 profile 位于 `output/playwright/settlement-latency/long1000-initial.cpuprofile`。

新增测试脚本语法检查、`git diff --check`、客户端产物一致性检查通过；两次完整 E2E 均先通过正常开局、官方 MVU 结算及刷新保留，再执行长档采样。没有改动用户实际存档。
