# 旧存档迁移到原生分页布局

日期：2026-09-28。

## 结果与范围

新增显式 `migrateNative`，将旧 JSON、snapshot/journal 或此前 `legacy-compatible-json-v1` 转成新局使用的 `conversation-state-v2` / `runtimeLayout: 1`。旧兼容迁移默认行为不变；本次没有启用启动时批量迁移，没有操作用户存档，没有修改 DSH 本体或新增宿主运行时补丁。

此前 `migrateCompatibility` 只是将完整 Chat 的 JSON 拆为增量树；它不提供原生消息窗口。这次迁移创建消息页、当前变量、运行时字段引用和场景索引，接入与新局相同的读写路径。

## 切换与历史

迁移与当前版本的 Chat 写入共用跨进程锁。先生成不可变块，再从这些块完整读回，与源 Chat 深比较，并重新检查源版本。全部通过后才原子发布 `head.json`。验证或写入失败时没有有效新 head，旧存档继续可用；遗留的未引用块可在重试时复用。已经激活的新存储损坏时会报错，不静默读取过期旧备份。

保留旧 JSON、snapshot/journal、兼容存储与其历史。迁移前的历史 revision 仍由保留的原存储提供；迁移时及其后的 revision 由原生存储提供。迁移不增加剧情轮次，不改变 Chat revision，也不重算变量或重放待处理副作用。

迁移后的新进度只写新存储。`--restore-legacy` 目前仅适用于兼容存储，明确拒绝原生分页存档；不能用旧文件冒充包含最新进度的降级导出。保留文件不可提前清理，它们还承载旧历史版本。

## 使用

先停止使用目标存档的服务，在副本上试迁移，确认后再处理原档；旧版本程序不参与新的锁与格式选择协议，不能同时写同一数据目录。

```sh
node bin/migrate-conversation-storage.mjs --data /path/to/tavern-data --chat CHAT_ID --native
```

重复执行返回 `alreadyActive: true`。缺失存档、损坏数据或验证失败不会报告成功。不带 `--native` 保留原有兼容格式迁移用途；不能同时传 `--native` 与 `--restore-legacy`。

## 实际浏览器验证

命令：

```sh
TAVERN_E2E_TIMEOUT_MS=60000 node tests/e2e/gameplay.mjs --migrate-native
```

产物：`output/e2e-gameplay/run-WJRVDl/report.json`。真实隔离 DSH + Tavern + Chromium，模型使用固定测试响应。只将隔离环境自动生成的 Tavern 存档重建为旧 journal，宿主 Session 日志保持原样。

结果：通过，总测试时间 82.083 秒。迁移时 revision 17，逐一核对 17 个历史版本；迁移及读回核对用时 188 ms。这是小型功能样本，不能外推到万轮大档。

迁移后完成重开、继续游玩、候选选择、正文重新生成、编辑与刷新、回退与撤销回退、Guide 操作、MVU 重新结算、对话导出、三次预设切换及继续游玩，最后服务重启。最终 revision 112、11 条消息、金币 70，重启后核对通过。

回归测试覆盖三种来源、原文件字节保持、未知字段及待结算回执保留、历史版本、迁移后增量写入、重复迁移、源文件变化、磁盘写入失败、验证前不发布、失败后重试和新存储损坏时禁止旧档回退。首次转换与完整校验是 O(N)，当前尚未测量万轮迁移耗时和峰值内存。

存储回归 **55/55 通过，无跳过**：

```sh
node --test tests/native-conversation-migration.test.mjs tests/legacy-compatible-storage.test.mjs tests/conversation-page-store.test.mjs tests/native-conversation-storage.test.mjs tests/conversation-migration-audit.test.mjs
```

`node bin/build-tavern-client.mjs --check` 与 `git diff --check` 通过；本次没有客户端源代码变更。
