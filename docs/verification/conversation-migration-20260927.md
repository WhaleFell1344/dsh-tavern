# 第二阶段：旧 Chat 无损映射与只读验证

对应 [数据结构设计](../design/current-state-and-paged-history.md)。本阶段把第一阶段的存储原型用于真实 journal 读取结果，但不切换生产权威数据、不修改源文件。

## 结构变化

`legacy-conversation-mapping.js` 负责以下映射：

| 旧字段 | 新结构 |
| --- | --- |
| role、text、sourceText、turn 等正文必要字段 | 历史分页中的 content |
| 消息 variables（含所有 swipe 的状态） | 独立不可变记录，以 variablesRef 引用 |
| mvuBaseline | 独立不可变记录，以 baselineRef 引用 |
| mvu submission、prepared effect、回执、swipes、模板标记与未知消息字段 | 按消息关联的 fieldsRef，普通正文分页不读取 |
| 当前 chat 变量、姿势、剧本状态等 | 当前状态的 chatFields，保留原字段是否存在 |
| 最后有效消息的选中变量 | 当前状态的 messageVariables，使用现有 lastTavernHelperVariables 选择规则 |
| timeline、nativeCommits 与未知 Chat 顶层字段 | 独立 headerRef；不随正文第一页加载 |

相同变量或基线复用内容寻址记录。映射保留原字段顺序；通过独立 originalKeys 描述来源位置，引用标记不会混进用户数据。Chat 局部变量和消息 MVU 变量没有合并成一套作用域。

这是承接旧语义的映射层，尚未把冷记录中的 operation、checkpoint、原生投影映射全部转换成设计中的新领域对象。它的意义是先拆开热读取数据，并证明旧信息能够完整找回。

## 安全边界

- 导入前验证输入是可无损表示的 JSON，拒绝 undefined、稀疏数组、访问器、隐藏字段、特殊对象及循环引用，避免 JSON.stringify 静默丢字段。
- 首次 await 前捕获源快照，调用者后续修改不改变正在导入的版本。
- 从磁盘重新读取分离的记录，逐消息与顶层字段核对值和字段顺序，再发布目标 Head。中途失败没有可见的半份目标；重试可复用已落盘的不可变记录。
- 完整导出固定 Head 快照，逐页还原后校验源 JSON 摘要。缺字段、错误引用、损坏块或未经映射协议修改后的状态会明确失败，不返回看似完整的数据。
- 保留 null 与缺失的区别；未知字段和 `__proto__` 等合法 JSON 字段不丢失，也不改变对象原型。
- 已存在目标拒绝覆盖。源存档保持权威；导入不会删除源、改变源 revision 或自动修改运行时入口。

## 可执行只读审计

```sh
node bin/verify-conversation-migration.mjs \
  --source-data /path/to/source/data \
  --chat CHAT_ID \
  --target-root /path/to/separate-shadow-root \
  --target-id SHADOW_ID
```

必须显式指定源和独立目标目录；相同、相互包含以及通过符号链接形成重叠的目录会拒绝。该命令没有自动激活功能。

命令通过真实 `chat-journal-store` 恢复快照及后续 journal，确认读取期间源版本稳定；导入后从新存储完整导出并核对。若审计结束时发现源版本变化，报告 `source-changed` 并返回退出码 2；目标只是捕获时的独立快照，不能当作当前副本。

即使报告 verified，`activated` 始终为 false。这不是持有源写锁的切换协议；最后检查之后仍可能出现新写入。后续正式切换必须冻结或协调源写入并再次校验，不能据此报告直接替换运行中的存档。

## 实测

执行 `node tests/experiments/conversation-migration-performance.mjs REPORT.json`。使用真实旧 journal 存储及一次后续字段更新，分别构造 2000/20000 条消息；包含消息变量、MVU baseline、回执、模板标记和未知字段。源 JSON 约 3.74/37.49 MB。

| 指标 | 千轮 | 万轮 |
| --- | ---: | ---: |
| 一次性映射及目标创建 | 0.508 s | 4.752 s |
| 独立完整导出核对 | 0.110 s | 0.728 s |
| 旧 journal 读取最后 50 条（5 次） | 24.8–27.5 ms | 303.3–318.0 ms |
| 新结构读取最后 50 条与当前状态（5 次） | 1.06–1.38 ms | 1.46–1.79 ms |
| 新结构每次读取历史块 | 2 | 2 |
| 新结构每次读取历史详情/变量记录 | 0 | 0 |

每次使用新的存储实例，不依赖应用热缓存；操作系统文件缓存未清空。对照核对了相同的 50 条可见正文、角色和当前变量。旧切片还携带历史变量及额外元数据，新结构按设计不读取这些内容，所以这不是“相同完整返回对象”的微基准，而是完成显示所需数据的结构对照。没有模型、浏览器或真实 MVU 执行，不能与此前整轮 100 多秒直接计算倍率。

原始数据见 [JSON](./conversation-migration-20260927.json)。映射成本一次性为 O(N)，普通窗口读取不恢复全历史；不把导入或导出的全量耗时算作正常打开。

## 本阶段验证与下一步

覆盖逐字段及 JSON 顺序往返、未知字段、全部 swipe 变量、pending submission / prepared effect、空历史、Helper 特殊楼层、缺失/null、记录去重、冷页不读变量、原始 journal 增量恢复、源文件版本不变、已存在目标保护、失败后重试与源对象并发修改。

最终检查：`node bin/test-tavern.mjs` 3026 通过、0 失败、10 跳过；客户端生成产物 `--check` 与 `git diff --check` 通过。另通过真实 CLI 子进程验证输出 `verified`、`activated=false`，源 journal 版本未变化。未运行新的浏览器 E2E，因为生产客户端及默认读取流程尚未切换。

下一步接入领域读取与提交：将冷记录中的 timeline / operation / delivery 映射成可单独寻址记录，处理旧历史修订及完整导出语义，再接首屏分页、正文追加和 MVU。此映射版导出固定旧来源摘要，明确不支持将任意新格式写入伪装成可还原的旧档；需要先实现相应领域写入协议。

本轮不修改生产客户端和默认存储，不执行用户存档的自动迁移。当前断点重试会重新遍历源，但复用已经写出的块；尚未实现可跨进程保存进度的正式迁移器，也未实现孤立块清理。
