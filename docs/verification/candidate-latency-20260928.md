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

## 用户授权后的同局浏览器实测

已手动操作“银麒系统末日倒计时开场”，使用原生生成/重新生成候选按钮，未选择候选发送正文。每轮修改后重启服务并重新加载页面。临时计时仅输出阶段名与毫秒时间戳，结束后移除。

首次实测（已加载上一节优化）：

| 时点 | Unix ms |
| --- | ---: |
| 前台调用提交 | 1790585006913 |
| 服务端收到 | 1790585006916 |
| 准备开始/结束 | 1790585007342 / 1790585010805 |
| 开始执行 runner | 1790585011011 |
| agent.followup | 1790585015360 |
| 接受候选工具提交 | 1790585022182 |
| 模型返回 | 1790585022187 |
| 候选提交结束 | 1790585023028 |
| 任务完成 | 1790585023333 |
| 前台 ready | 1790585023342 |

发现：同一次请求两次解析世界书，每次约 2.6s；后台 bind 等仍处理全量 metadata；纯任务状态变更还调度模板显示同步，与生成前的模板解析争用队列。

新增优化：

- 同一个候选请求的 planner 与 runner 复用本次世界书投影；下一次请求重新解析，不建立跨请求陈旧缓存。
- 候选 begin/bind/commit 走带 revision 校验的局部 metadata 提交，保留冲突回退、历史索引与剧情版本。
- 纯 mailbox、candidate begin/bind 不触发模板显示同步；纯 mailbox 写入不重写侧栏摘要。
- 局部投影保留摘要需要的 title/createdAt/lastOpenedAt/backgroundHistoryIds 字段。
- 前台可直接投影已经持久化的候选完成结果，不等待冗余 mailbox 写入队列；恢复流程仍可从权威候选修复任务记录。

中途测试捕获候选可选字段的 undefined 与增量树 lossless JSON 不兼容，已修复规范化和删除语义。增加真实原生存储集成测试，确认候选提交成功且原剧情保留。

最后一次无并行测试负载的实际时点：

| 时点 | Unix ms |
| --- | ---: |
| 前台提交 | 1790586147561 |
| agent.followup | 1790586154840 |
| 接受候选工具提交 | 1790586161985 |
| 前台 ready | 1790586162311 |
| 前台已提交 DOM 后的 RAF | 1790586162323 |

实际 DOM 确认可见“5 个候选项”。提交到展示 338ms。启动端最后一轮 7279ms；另一轮无测试负载的热态数据为 5098ms（1790586035365 → 1790586040463），因此不能宣称稳定达到毫秒级启动。模板环境读取/准备仍约 2.6–3.1s；这部分为明确保留的后续优化空间。不要把此次改动描述成全部启动延迟已经消失。此前一轮与自动化测试重叠的计时不用于最终改善结论。

最终回归：112/112 通过，客户端生成文件一致性与 git diff --check 通过。临时计时埋点已移除，服务已重新启动加载清理后的版本。

## 继续优化点击到后台开工（17:35）

这一轮继续使用同一局、同一候选生成按钮，未选择候选或发送剧情。重启后分别测首次候选请求与不重启的连续请求，计时期间没有运行自动化测试。

定位到的额外成本：

- 只有 7 条消息的对话也走最近 200 条模板历史窗口，每次返回完整窗口而没有 cursor，绕过增量同步。窗口读取存档头单次约 450–1039ms。短历史现在先检查 `requirePartial`，未截断时使用完整首读和后续 cursor 增量；长历史保留窗口和按需历史访问。
- 当前卡的人物投影按缓存原算法计约 56.2MB，超过 16MiB 上限，导致每次刷新重建/指纹计算（约 95–130ms）。人物投影缓存上限改为 64MiB，仍按内容比较和 LRU 淘汰，不使用 TTL。
- 原生存储的解码缓存仅在一次读取内有效。现在在同一存储的内容哈希命名空间内共用 128MiB 有界缓存，公共读仍返回独立对象，始终读取最新 head。单存档重复读取探针由约 522ms 降至 11–14ms；该数值不是整链路时间。回归包含另一会话读取、外部修改和旧 revision，避免把最新 head 或可变对象缓存成权威状态。
- 模板增量只选择所需字段，同时保留本局人物卡/世界书快照，避免空增量刷新退回工作区卡资源；候选准备向已有 `readCard(path, chat)` adapter 传入本局快照。
- 新候选提交直接持久化为 running/preparing，省去紧接着的 queued→preparing 第二次存档。恢复的旧 queued 任务仍在准备前领取；generating、绑定和结果依旧持久化。重复请求只执行一次，运行中断恢复规则不变。

最终两个实测：

| 请求 | 点击 Unix ms | agent.followup Unix ms | 间隔 |
| --- | ---: | ---: | ---: |
| 重启后首次候选请求（先正常打开本局） | 1790588101264 | 1790588103345 | 2081ms |
| 同局连续请求 | 1790588136332 | 1790588138302 | 1970ms |

两轮均实际显示“5 个候选项”。这里的后台开始以调用 agent.followup 为界，不是供应商开始计算或首 token 时间。仍未达到用户期望的几百毫秒。首轮任务声明、begin、generating、bind 四次持久化约 1.1s，世界书准备约 652ms；连续请求仍有类似成本。不能把本次结果描述成瞬时启动。

曾尝试合并页面存储提交内重复的目录同步；存档副本探针没有显示明确收益，已撤回该试验，持久化屏障保持原实现。

最终回归 161/161 通过：background-task-coordinator、candidate-generation、candidate-tasks、durable-task-mailbox、task-state-reader、native-conversation-storage、chat-journal-store、incremental-json-state、template-window-reader、template-projection-freshness、server-template-native、full-prompt-template-state、full-prompt-template-sync、immutable-json-projection。构建和生成文件一致性检查通过。临时计时探针已移除；最终服务重启加载无探针版本。
