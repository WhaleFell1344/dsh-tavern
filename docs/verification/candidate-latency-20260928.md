# 候选任务启动与结果显示延迟

用户报告点击生成后后台启动慢、后台完成后前台迟约一两秒显示。本次没有把后台视觉状态当作前台已收到结果的证据，也没有在用户当前游戏里额外发送模型请求。

## 已测到的瓶颈

使用实际 `chat-mukxt6tb-u7m8xy` 原生存档的临时副本，在真实 Chat Persistence / Durable Task Mailbox 上提交和推进任务，不修改原存档。探针位于忽略目录 `output/diagnostics/candidate-latency/probe.mjs`。

原路径读取首次 456ms，后续 3–4ms；六次保存分别 513、348、275、263、264、269ms。每个 mailbox 阶段都走 full read/write，包含与任务无关的卡片和历史数据。候选模型结束后仍顺序等待 validating、committing、publishing 三次阶段存档，然后才完成任务。

改为 mailbox CAS 字段提交后，发现 native patch 本身仍展开完整 header，因此只改 mailbox adapter 不足以优化。增加仅支持 taskMailbox / revision / updatedAt 的原生树提交路径，保持剧情、世界与索引不变。同副本读取 4–11ms，第一次 patch 372ms，后续 187–210ms。该测量含文件系统持久提交，不代表页面端到端耗时。

## 修改与保证

- Mailbox 用已有轻量任务投影读取，仅 CAS 更新 taskMailbox，版本冲突重新读取并重试，保留传统 adapter fallback。
- 原生存储仅对上述字段的 set 操作走快速路径，保留历史 revision 映射及原先失效的索引状态，未读取/重写正文和世界。
- Candidate Tasks 不为校验/提交/发布三次短阶段增加持久 checkpoint；排队、开工、执行和最终结果仍然持久化，失败恢复仍从权威候选结果校准。

验证命令：

```sh
node --test tests/durable-task-mailbox.test.mjs tests/candidate-tasks.test.mjs tests/candidate-generation.test.mjs tests/native-conversation-storage.test.mjs tests/chat-journal-store.test.mjs tests/task-state-reader.test.mjs
```

80/80 通过。新增测试覆盖拒绝全量读写、CAS 冲突重试、保留并发剧情修改、历史版本、世界/正文不变与旧 revision 拒绝。

## 边界

没有采集当前用户那次操作的点击、模型请求、工具完成、前台渲染四个真实时间点。因此本次确认并优化的是存储阶段开销；模型准备、排队和浏览器同步还不能声称全部消除。用户正在游玩，本次未主动重启服务打断任务，需下次重启加载服务端修改。
