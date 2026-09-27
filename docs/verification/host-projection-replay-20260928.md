# 宿主历史统计重放优化（2026-09-28）

## 问题与改动

上一轮原生万轮存档打开到状态栏就绪仍需 13.734 秒。已有 CPU 采样 run-mm3haW 中，DSH Token Meter 自身约 7.215 秒，主要是 contextBreakdown 的累计数组复制、追加与向后查找系统节点；turnOutline 同样每回合复制累计条目。这些统计在冷加载时阻塞页面就绪，即使 Tavern 正文已经分页。

新增 `host-projection-replay.js`，在 Tavern 启动时安装可卸载的宿主适配，只优化尚未发布给观察者的 `buildCell` / `restore` 批量重放：

- contextBreakdown v4：追加事件交给原生 apply 计算 Token 值与 breakdown，但只传最新非空系统节点；完整节点保存在批次私有数组中。历史替换仍将完整数组交给原生算法，后续追加重新定位系统节点。
- turnOutline v2：原生 apply 用最后一条回合计算边界、提示和回复预览，批次私有数组保留完整回合目录。
- 首次修改先复制输入数组，避免污染共享 init 或已有检查点。仅本批次拥有的数组可原位追加。每次 batch 使用独立适配器。
- restore 使用私有 registry 视图，原生定义不被替换；原生序列校验、schema 解析、检查点格式和异常均保留。实时 apply、通知与旧状态隔离维持原实现。
- 未识别的宿主接口或 projection 版本回退原实现。没有修改用户安装的 DSH 包，也没有更改存档格式。

这是私有宿主接口适配；升级宿主时必须运行原生对照测试。宿主提供高效 batch fold 后应删除这一适配层。状态版本门控不能代替升级时的契约验证。

## 验证

`host-projection-replay-native.test.mjs` 使用实际安装的 DSH 宿主定义逐项对照：完整状态、每个中间截点、空系统消息、系统节点替换、普通历史替换、工具结果、请求头、检查点续读、坏序列、坏 schema、输入隔离、实时更新隔离、重复安装与卸载、未知版本回退。

万轮对照保留全部 20001 个统计节点 / 10000 个回合目录。优化后的追加只向原生 apply 传至多一条旧记录，避免用不稳定的耗时阈值代替复杂度断言。微基准：原生两个 fold 共 1984.0 ms；优化后包含两次 fold 和完整相等检查共 134.3 ms。微基准不是浏览器打开时间。

相关回归命令（29/29 通过，无跳过）：

```sh
DSH_BOOT_MODULE=/Users/cf/.dsh-tavern/runtime/lib/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js node --test tests/host-projection-replay-native.test.mjs tests/session-events-native.test.mjs tests/rollback-turn-projection.test.mjs tests/background-surface-projection.test.mjs
```

额外运行旧 `tavern-token-meter-native.test.mjs`，2/10 通过、8/10 失败。以 HEAD `8a0cfcb1` 的源文件和测试在独立临时目录复跑，同样 8 项失败；原因包括当前宿主拒绝 assistant 消息上的 sourceEventSeqs。该测试未安装本次新增适配，失败属于已有宿主协议兼容基线，本轮未修改它。不能宣称整个测试套件全绿。

客户端生成文件检查、git diff --check 通过。

## 真实浏览器结果

严格 E2E `run-mQUIoR`：隔离真实 DSH、Chromium、官方 MVU；10000 轮、19999 消息、391573697 字节、三字段变量。计时期间未并行运行测试或构建。

| 指标 | 上轮 run-Mp1NU1 | 本轮 run-mQUIoR |
| --- | ---: | ---: |
| 冷打开到状态栏就绪 | 13.734 秒 | 4.960 秒 |
| 点击会话到正文显示 | — | 1.965 秒 |
| 重新结算到结果可见 | 5.631 秒 | 5.042 秒 |
| MVU 浏览器完成到持久化 | 1.160 秒 | 1.085 秒 |
| 打开期图片点查询 / 全历史查询 | 25 / 0 | 25 / 0 |

打开等待减少约 64%。这是单次样本，不是稳定分位数；重新结算变化小，不归因为此次优化。独立进程启动另耗时 7.576 秒，不包含在打开到状态栏的 4.960 秒里。

首次新建、游玩与刷新、构造长档后冷打开、严格 MVU 禁止整档工作副本、事务内按需访问旧楼层、结算落盘、服务重启核对当前变量均通过。万轮阶段计量的是重新结算，不据此宣称普通追加游玩的万轮性能。

```sh
TAVERN_PERF_REQUIRE_SCENE_INDEX=1 TAVERN_PERF_ROUNDS=10000 TAVERN_PERF_FIELDS=2 TAVERN_PERF_RUNS=1 TAVERN_PERF_HISTORY_READY=1 TAVERN_PERF_BODY_REPEATS=60 TAVERN_PERF_REQUIRE_LAZY=1 TAVERN_E2E_TIMEOUT_MS=120000 node tests/e2e/gameplay.mjs --native-format --settlement-performance --history-demand
```

## 剩余边界

本次将普通追加历史的统计重放由反复复制累计数组的 O(N²) 降为单次 O(N) 遍历，保留完整目录和计数。没有使整个打开链路变成轮数无关的 O(1)：宿主事件恢复、全量目录输出与统计检查点处理仍会随历史增长。要继续接近只读当前状态的目标，需让首屏脱离完整宿主恢复，并按需获取历史目录 / 使用有效检查点；不能截断历史或隐藏统计来冒充完成。
