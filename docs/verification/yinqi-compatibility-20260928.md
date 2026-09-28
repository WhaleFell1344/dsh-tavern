# 银麒卡兼容验证（2026-09-28）

本轮处理脚本已加载后仍发生的变量保存拒绝与开场向导缺失。之前的大脚本 Blob 装载修复独立于本轮。

## 复现与修复

- 原卡初始化通过 `chat[i].variables[swipe_id]` 补齐字段，再调用 `saveMetadata/saveChat`。原接口只支持插件字段，导致变量及元数据一起保存失败。调用栈定位到面板初始化迁移，不是已禁用的 MVU 历史清理。
- 兼容保存只接受最新变量快照的当前 swipe，与插件元数据同一事务落盘。服务端校验读取版本、聊天生命周期、消息身份及历史长度；变量冲突、旧楼层、非当前 swipe 或删除快照均拒绝。正文、Frame 和 Story Timeline 不被改写。
- 原向导查找 `.mes[mesid="0"] .mes_text`，正式对话原先没有该节点。为受信任开场提供独立脚本 DOM，脚本替换后隐藏原生正文；React 继续维护自己的树，避免脚本 `innerHTML` 破坏 React 节点。

## 实测

使用原卡已有存档、真实浏览器验证：向导显示“已检测到匹配宿主”，点击“开始绑定”进入环境自检；手机和系统面板脚本正常初始化。原卡迁移版本和 schema 版本均已保存为 2，刷新后恢复。验证不提交向导最终确认、不发送剧情生成请求。

14:42 的“插件存档不接受聊天正文或历史操作”来自新前端请求先于后台重启生效；后台完成重启、页面刷新后没有继续产生该错误。

自动测试覆盖变量与元数据原子保存、重开恢复、并发冲突、保存期间的新编辑、旧生命周期/历史/swipe 拒绝、懒读取历史、脚本 DOM 与原生树隔离，以及现有 MVU 事件/回执路径。

## 模型与范围

代码确认：MVU 状态更新由 `createMvuSettlementModule` 使用 `backgroundAgentRunner`，后者解析本局后台模型选择。这条路已存在，不需再向卡内填写额外 API 密钥。本轮在脚本开场旁说明这一点，没有伪造 API 配置，也没有启用卡内第二套自动解析。

卡内自检仍按 SillyTavern 设置判断，可能提示额外 API 和脚本列表问题；这不等于 DSH 后台模型未连接。未声称所有独立手机/任务 API、卡片自身全部功能或最终生成链路已经验证。

## Extra text-model routing

Card `generateRaw` and script-local OpenAI-compatible `/chat/completions` requests now resolve the session background model on the server for every request. Opening preparation also uses that selection (falling back to the host selection when no game exists). Card connection credentials are never passed to the provider. Direct completion responses support JSON and buffered SSE; this is not incremental provider streaming. Unsupported tools and non-text messages fail explicitly.

The legacy phone API registry projects the host connection for all existing channels, including task/shop evaluation. Its stored connection values are preserved via serialization; enabled/automatic-generation preferences stay under user control. Both phone settings and the system panel's connection form show the managed-model notice instead of URL/key/model controls. Image download/generation endpoints are not text-model endpoints and are left alone.

Validation: real saved session opened successfully after restart; phone message settings displayed the managed-model notice with connection fields hidden and feature controls intact. A neutral direct request through the live `generateTavernHelperRaw` completion bridge returned HTTP 200 and `OK`. No card gameplay generation was triggered. Regression coverage exercises credential isolation, JSON/SSE responses, pre-aborted requests, asset passthrough, legacy settings serialization, form adaptation, raw generation and chat-data handling.

Limitations: an AbortSignal rejects the client wait but does not cancel an already dispatched provider request; SSE is buffered. APIs using other protocols or XHR are not covered by the fetch bridge. The neutral request validates connectivity, not every card feature's prompt/result parsing.

## Host-managed MVU self-check

The legacy guide's five MVU checks are adapted during module loading when the actual session context enables host MVU. They report host ownership and return no legacy fix action, instead of demanding a client-side updater or an exposed API key. Unmanaged sessions retain the original checks. The card file/settings are not rewritten. Connection ownership is explicitly distinguished from a successful model connectivity test.

Real browser verification after service restart: the original card's self-check changed from three severe errors plus one suggestion to one suggestion only. All five managed messages were visible; the remaining suggestion is the existing inability to read the card script list, not a model API problem. 73 focused tests passed, including unchanged legacy checks when host MVU is not enabled, and generated-client/diff checks passed.

## Legacy opening submit bridge

The final guide step writes its setup and then finds `topDoc.getElementById("send_textarea")` / `send_but`. In the shared script sandbox these controls were absent, so the card only warned in the console after already showing its waiting screen. The model was never requested.

Shared scripts now receive sandbox-owned legacy controls. Those parent-DOM lookups are redirected to the calling sandbox; submissions use a scoped Helper message and the original session's prompt API. Text is sent literally (no slash-pipeline parsing), pending clicks are deduplicated, the user's composer draft is untouched, and inactive/stale runtimes are rejected with a surfaced error. Existing message-frame/preparation composer behavior remains intact.

Validation uses neutral payloads for the old DOM lookup, duplicate clicks, exact prompt dispatch, failure retention, and existing lifecycle/chat-data regressions. No card gameplay request was generated during verification. Already-completed guide callbacks are not replayed after refresh; their saved configuration remains available and the user can submit a continuation from the normal composer.

## Reopen saved greeting projection

Live DOM inspection distinguished a display regression from script startup failure: phone/system widgets were present, while the hidden legacy message contained the persisted binding-complete message and the visible React subtree still showed the original YINQI_BOOT text. The guide intentionally skips boot rendering once its raw message no longer contains the marker. The wrapper previously revealed saved text only after a new script DOM mutation, which never arrives in this state.

The greeting wrapper now immediately displays persisted text when it differs from the original text blocks. An already-bound, single-message opening that carries the legacy waiting text has an explicit continuation button using the scoped prompt bridge; it retains setup, disables repeat clicks and displays submission errors. This does not replay a gameplay request on reload.

Verification: after service restart, the actual saved session displayed binding-complete text, the continuation button, phone and system panel; the raw YINQI_BOOT fallback was absent. 76 focused tests passed, including reopening with no subsequent script DOM mutation. Build and diff checks passed. Gameplay generation was not triggered during the UI check.
