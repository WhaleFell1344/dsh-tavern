# 新建存档接入原生分页格式

本次验证的是全新合成存档，不以旧档迁移或 `legacy-compatible-json-v1` 的通过结果代替新格式验收。

## 接入范围

正式插件入口为新建游戏启用 `newConversations`。首次保存直接创建 `conversation-state-v2`，在 `chats/<id>/` 内只建立 `head.json` 与 `blocks/`，不先建旧 snapshot/journal 再转换。人物卡编辑会话仍保持原存储。已有旧档继续按原格式读写，本次不执行迁移。

运行时桥接布局标记为 `metadata.settings.runtimeLayout = 1`：

- 历史消息由分页索引管理，每页保存消息身份和 `runtimeRef`，不内嵌大变量快照。
- `runtimeRef` 指向消息的不可变 JSON 树；正文、变量、MVU 回执和未知扩展字段都能无损重建。未改变的内容寻址块共享。
- 当前世界单独由 `worldRef` 指向，包含当前消息变量及姿势。`worldMessage/worldSwipe` 记录选中的来源。
- `chatHeaderRef` 保存设置、原生会话映射、Helper chat/script 作用域和现有回退元数据的不可变树，不包含 messages 数组。
- 一次写入通过单次 Head CAS 发布消息页、当前世界和头部引用。历史 revision 指向旧 Head，供原有三方合并读取。
- 变量叶子变更映射到消息树和当前世界树的相应路径；回退、换 swipe 等切换当前世界的操作显式选择新基线。
- 截断历史保留不可变旧快照；再追加时裁掉页内已删除的尾部，避免旧消息复活。提交守卫在发布 Head 前再次检查。

这是一层实际运行时适配，不是把完整旧 Chat 塞进单个新存储节点。也不是替换全部玩法领域接口：正式 MVU 执行器、timeline、原生 Session 与待完成任务的生命周期仍由现有运行时维护。原型 `commitForeground/calculateSettlement` 的任务协议不与该运行时布局混写；`commitForeground` 明确拒绝此布局。现有完整 Chat API 仍提供隔离对象。

## 验收

复现命令：

```sh
node bin/build-tavern-client.mjs --check
node tests/e2e/gameplay.mjs --native-format
node tests/e2e/gameplay.mjs --native-format --mvu-incremental
node --test tests/native-conversation-storage.test.mjs
node bin/test-tavern.mjs
```

浏览器使用真实隔离 DSH、当前插件与官方 MVU，只固定模型输出，不 mock 变量 RPC 或存储。没有使用用户资料目录。

两套 E2E 均通过。第一套覆盖新建、游玩、候选行动、刷新、重生成、编辑、回退/撤销、Guide、重新结算、导出、预设切换与服务重启。最终 11 条消息、金币 70；直接读取原生 Head 的 revision 为 116，文件目录仅 `blocks` 和 `head.json`。

第二套覆盖历史楼/末楼变量、chat/script 变量、第二页面不刷新同步、正式 MVU 重算、服务重启后继续写入。最终历史楼金币 3、末楼金币 13，作用域变量和正文均保持正确。

两个测试都在开局及服务重启后用独立 `createConversationState` 读取器核对磁盘格式、当前世界变量、消息总数和 revision；不是仅检查页面可见文字。原始摘要见同目录 `native-gameplay-20260927.json`。

适配层专项 4 项通过，覆盖跨页回退再追加、旧 revision 重读、旧存档保持原格式、并发三方合并、取消发布、损坏拒绝回退，以及叶子变量更新不读写无关的大字段。存储与事务专项 103 项通过。完整回归 `node bin/test-tavern.mjs` 为 3072 通过、0 失败、10 跳过。

计时探针已适配原生 Head 发布，同时保留旧日志追加的阶段名。用 2 轮、2 个额外字段、1 次重算的小样本复验通过（`run-4uxQiF`）；记录的 `persistenceKind` 为 `native-head-published`，MVU 浏览器事件完成到持久化约 3400 毫秒，commit 约 2297 毫秒。该结果证明探针可用，也说明写入开销仍需优化，不能推导万轮性能。

## 性能与边界

本次确认基础功能接通，不是万轮性能达标验收。两套 E2E 总耗时约 165.6 秒和 70.2 秒，包含启动、截图、模型流程和重启，且运行时有其他回归测试，不能当作纯结算耗时或严格前后对比。

现有前台仍有完整 Chat 物化入口；桥接的冷读取仍会读取全部历史。新消息建树、全量调用、首次变量建树与每块同步持久化也仍有开销。要兑现万轮快速打开，还须让运行时和前台直接消费尾页/当前状态，并测量真实分段耗时。当前不可变旧版本尚未垃圾回收。

本次没有迁移或删除旧档，没有推送发布。
