# 原生存档 Helper 读取专项

基线：`8dcc5db5`。本轮只处理新格式读取，不迁移真实存档，不提高整档缓存上限。

## 改动与边界

`getTavernHelperContext` 和初始化的 `hydrateTavernHelperMessages` 新增原生读取路径。读取器固定一个不可变 Head，再按指定范围获取分页内的消息引用，只解码 Helper 需要的消息字段。消息变量、所有 swipe、插件数据、角色、隐藏标记、名字和楼层编号保持原语义；完整上下文请求仍返回完整历史。范围请求只读取必要的身份/版本元数据，不读取整个 Chat 头。

消息的 MVU 基线、显示诊断等内部字段不再为 Helper 请求解码。返回结果仍是独立对象，旧格式保留原路径。正式结算事务的上下文和显式提供 Chat 的事件继续使用原有事务路径，避免读取已提交状态覆盖未提交草稿。

这不是默认只加载末尾 48 楼的完整实现：当前浏览器初始化仍请求全部待补齐楼层，`getSession` 冷视图仍调用完整 Chat 读取。不能据尾页探针宣称万轮打开达标。

## 验证

- 123 项相关回归全部通过；随后增加旧格式回退测试，存储专项 9 项通过（共 124 个不同用例）。客户端生成物检查通过。
- 新增测试跨 500 条读取批次核对完整 Helper 投影；范围读取不触及历史页及当前楼层内部大字段；完整 Chat 的字段和对象隔离保持不变。
- 官方 MVU、真实 DSH/Chromium、原生格式功能 E2E：`run-uq0WTx` 通过，52.1 秒。覆盖历史/末楼变量、chat/script 变量、第二页面同步、服务重启和继续写入。
- 第一次相同功能测试 `run-A7Ua6C` 在第二次变量写入出现 `messages` 并发冲突。未修改写入冲突规则，复测通过；该并发问题没有在本轮证明消失或证明属于基线，不能宣称测试从未失败。

命令：

```sh
node tests/experiments/native-storage-performance.mjs --rounds=10000 --helper
node tests/e2e/gameplay.mjs --native-format --mvu-incremental
TAVERN_PERF_ROUNDS=10000 TAVERN_PERF_FIELDS=2 TAVERN_PERF_RUNS=1 TAVERN_E2E_TIMEOUT_MS=120000 node tests/e2e/gameplay.mjs --native-format --settlement-performance
```

万轮底层探针（20,000 条消息）：Helper 冷读末尾 48 条约 **11.0 ms**，读取 **2 个消息页**、约 **124 KB**；完整 Chat 冷读约 **3031 ms**。它们返回的数据量不同，不是同一操作的加速比。构造期间部分时间与浏览器功能测试重叠，以上仅为本机观测。原始数据：`output/native-performance/scale-helper-10000.json`。

## 尚未达标

万轮完整浏览器 `run-4EoZZe` 仍在等待状态栏金币恢复时超时（120 秒），尚未采集长档结算耗时。日志仍有 8 次 `cache-oversized`，与之前的 10 次不能作为稳定提升结论。

后续仍需把默认视图和脚本启动协议改为当前状态与历史分开消费。当前 `live-tavern-view` 会补齐所有 `messagesPending`，执行模块等补齐后才启动脚本；仅优化读取器不能消除这项全历史前置条件。任意历史楼层的同步 Helper API 是兼容边界，需要明确按需读取协议，不能用空数据代替历史。
