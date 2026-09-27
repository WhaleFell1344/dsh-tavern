# 变量增量计算、传输与持久化

本阶段接入新分页存档的领域后端；旧 Chat / 浏览器 MVU 执行器尚未切换。下面的性能不是实际 UI 或人物卡脚本的端到端指标。

## 实现

`incremental-json-state.js` 提供不可变 JSON 变量树。对象键、数组下标经过哈希索引定位，叶桶最多容纳 32 个条目，祖先分支最多 16 个子引用；小标量内联，大值及子对象独立寻址。当前存档只保存 `worldRef`，历史消息保存状态引用，不再把全体变量嵌在每次提交的 Head 中。

- **计算**：`calculateSettlement` 提供异步 `get / set / delta / remove`。只读取所访问的路径；写入即时形成新树根并记录实际结果。计算可以读取自己的前序修改，例如扣钱后改变任务状态。无需全量复制，也无需比较前后全量变量。计算回调不放在 CAS 重试中运行。
- **传输**：完成结算后 `readSettlementDelta` 返回 operation ID、前后状态根、前后版本及实际 changes。算术 delta 变成最终 set 值；原子回执控制重复提交，接收方检查分支/生命周期/正文/世界版本及基线根。缺口或过期结果要求重新同步。
- **持久化**：准备结果只写变化值和祖先索引，结算只发布新根、消息引用及完成回执。未修改的分支复用原记录。失败留下的不可达准备块不会改变权威状态；后续还需要独立垃圾回收。

使用例子（路径相对于完整 world）：

```js
await domain.calculateSettlement(chatId, { operationId }, async state => {
  await state.delta('/variables/stat_data/金币', -10)
  if (await state.get('/variables/stat_data/金币') < 100) {
    await state.set('/variables/stat_data/任务/资金紧张', true)
  }
})
await domain.commitSettlement(chatId, { operationId })
const delta = await domain.readSettlementDelta(chatId, operationId)
```

这是新的状态计算接口，不是对官方 MVU JSON Patch 方言的替代解释器。它接收可信计算逻辑/实际效果；不能绕过官方运行时，把模型 operations 当作全部结果。回调限于状态计算，不应在其中调用模型、发消息或执行外部副作用。读取完整根或替换整个子树，成本仍与所涉及内容大小相关。

## 同步与兼容

`receiveConversationDelta` 与 `tree.receive` 在独立状态副本上验证传输结果；重复完成回执不再执行扣款。副本必须先同步正文版本，再接收对应结算。普通增量不会夹带未修改变量。

初次同步或发现版本缺口时使用 `exportSnapshot / importSnapshot`：复制当前树的可达块并校验内容地址，保留精确根引用，不重放历史。不能用重新编码后的普通 JSON 根替代原根，因为索引布局与键插入次序可能不同。

- 新建领域存档使用 `conversation-state-v2`。已有原型 v1 的内嵌 world 和历史引用仍可读，在领域写入时转为树引用。
- `open()` 默认仍返回完整 world，保持上一阶段调用者的契约；`open({ includeWorld:false })` 只读状态引用，事务内部统一使用此路径。`readWorld({path})` 提供显式按路径读取。
- `prepareSettlement({world})` 仍接受完整结果，并明确输出 `mode: snapshot`。`prepareSettlement({changes})` / `calculateSettlement` 才使用增量路径。
- 旧浏览器 MVU 脚本、Helper/EJS 的同步全量变量接口没有改写；其副作用和兼容行为保持原样。HTTP/WebSocket/UI 尚未接此新协议，独立副本测试不等于真实跨页面 E2E。
- 数组下标修改和尾部追加按路径处理；数组删除会移动后续下标，目前重新编码该数组。它不扫描其他变量，但不能声称与数组长度无关。

## 验证与测量

定向测试覆盖：万字段同层对象、1 万元素数组下标修改、未触碰的 1 MB 大值不被读取、路径转义和特殊键、键插入顺序、历史版本隔离、联动计算、失败不发布、准备后重启、增量序列化及独立副本重放、重复/错基线/跨分支拒绝、精确快照恢复及完整结果兼容。

性能脚本：

```sh
node tests/experiments/variable-delta-performance.mjs docs/verification/variable-delta-20260927.json
```

千/万字段均位于 variables 同一层，夹具包含额外 1 MiB 未修改字符串；每组连续三轮，只计算金币与等级两个标量路径。每轮创建新的领域读取实例；OS 缓存未清空。计时包括不可变块和 Head 的持久化；初始化单独记录，不包括模型、官方脚本、网络与浏览器。

### 实测结果

| 同层字段数 | 完整 world 大小 | 计算并持久化准备结果 | 最终提交 | 增量包 | 每轮写入 |
| --- | --- | --- | --- | --- | --- |
| 1000 | 1,063,403 B | 172.1–214.6 ms | 95.8–103.0 ms | 560 B | 7,941–11,763 B |
| 10000 | 1,216,403 B | 164.0–216.0 ms | 85.0–98.0 ms | 560 B | 8,988–14,123 B |

万字段组三次总读入为 44,696–52,448 B，没有读取 1 MiB 未修改字符串。写入数字包含准备数据、变量树变化分支、任务回执、消息页和 Head；不是仅统计补丁本身。每组只有 3 次样本，不能推断严格延迟上界，也不能与上一阶段不同历史规模的测试直接比较。

一次性建树：千字段约 3.2 秒、万字段约 37.2 秒。当前文件 Adapter 的大量独立同步写盘仍是导入成本，不能把它隐藏为正常冷打开。空间回收、批量建树写入和生产脚本接入仍需后续工作。

回归：完整 `node bin/test-tavern.mjs` 为 3053 通过、0 失败、10 跳过；随后补充精确快照恢复测试，并重新运行变量树与领域事务定向测试：26 项全部通过。未执行真实 UI E2E。

## 尚未完成

这一步消除了新领域路径对变量总量的隐式复制、传输与落盘依赖。接下来仍需将官方 MVU/Helper 写入转换为实际路径修改记录，完成脚本全量兼容入口的度量，再接新存储迁移、宿主同步协议与 UI。不能据此宣称现有产品里的所有 MVU 结算已经增量化。
