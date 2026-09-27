# 原生存档冷缓存读取与点写入

基线：`e3f4f1bb`。只操作隔离合成数据，不迁移真实存档、不提高整档缓存上限。

## 改动

- 冷缓存的非结构性 patch 只读取 Chat 头和受影响楼层，沿不可变记录路径提交；不先读取全部历史。保持修订号 CAS、提交前取消校验、旧版本引用和当前变量世界一致。结构性编辑、删除当前变量世界等仍走原完整语义回退。
- 原生存档没有缓存变更覆盖记录时，增量视图探测直接返回“没有覆盖”；读取整档不能恢复已不存在的记录。
- 冷启动 Helper 窗口按修订号复用。补齐请求绑定 chatId 和 revision，只有同一版本完整范围的真实楼层才能晋升为完整缓存，防止跨版本拼接和重复重建。
- 场景图片轮询保留原投影字段和完整历史语义，但不解码历史变量、MVU 基线、显示诊断和非激活 swipe。
- 不可变 JSON 树增加请求内 8 MiB 解码复用；返回值仍独立，超大对象不进入该缓存。整档缓存上限未变。

这不是只读取末尾页面的全部改造。完整 Helper API、冷视图、旧调用方和结构编辑仍可能物化全历史。冷点写入也需要解码被修改的楼层和头部，不能宣称所有路径 O(1)。

## 存储实测

命令：

```sh
node tests/experiments/native-storage-performance.mjs --rounds=10000 --helper --cold-patch
```

20,000 条消息：冷 Helper 尾部 48 条约 10.8 ms；完整冷读约 3178 ms；冷缓存修改最后一楼 20 个字段约 129.7 ms，9 次记录写、12 次链接写。页面读取计数含提交后的独立验证，合计 4 页。原始数据：`output/native-performance/scale-cold-patch-10000.json`。这是存储专项，不是浏览器整轮结算时间。

## 浏览器测量注意

CPU profile `output/e2e-gameplay/run-vCdhzo/browser.cpuprofile` 揭示 Playwright 注入脚本的 `trimString` 累计占用约 50 秒：对包含完整上下文的大 iframe srcdoc 生成元素预览影响测量。性能脚本改用 DOM handle 获取真实 Frame，再检查同一个状态栏元素，避免该元素描述开销，不改变验收的金币值条件。

该次万轮运行（约 175 MB JSON）曾打开并恢复状态栏，冷开约 98.9 秒，但结算金币更新等待 120 秒超时，不能算通过。其前的 `run-qoGim9`、`run-3knGWK`、`run-gbKOyy` 也有初始化超时。`run-o7zewb` 为测试辅助函数误读 iframe name 导致的失败，已改为 ElementHandle.contentFrame，不计入产品性能结论。

## 最终万轮结果与剩余瓶颈

修正测量路径后的 `run-Eh7MqB`：冷开到状态栏恢复 **82.2 秒**（独立运行时启动另计 8.8 秒），之后结算状态栏更新仍在 **120 秒超时**；浏览器无未捕获异常。不能宣称万轮游玩性能达标，也未获得“变量执行完成到落盘”的有效样本。该次完整日志见 `output/e2e-gameplay/run-Eh7MqB/server.log`，报告见同目录 `report.json`。

日志直接定位了后续整档读取调用：`runSettlement`、`background-task-coordinator.begin`、视图重建和通用 update 路径。约 307 MB 的内存估算大于 256 MiB 整档缓存上限，仍会反复物化后丢弃。需要把这些调用方继续改为当前状态/目标楼层接口，尤其后台任务启动和原生视图冷启动；不能通过提高缓存上限解决其复杂度。

## 回归

- 存储、修订号、Helper 缓存、JSON 树相关 74 项通过。
- 客户端、模块加载、持久化合并、视图同步相关 101 项通过。
- 客户端生成物检查与 `git diff --check` 通过。
- 最终真实 DSH + 官方 MVU + Chromium 功能 E2E `run-Awnd9X` 全部通过（40.8 秒）：新建原生存档、游玩、刷新、历史/末楼变量、chat/script 变量、第二页面冷开与实时同步、服务重启后继续写入。命令：`node tests/e2e/gameplay.mjs --native-format --mvu-incremental`。
