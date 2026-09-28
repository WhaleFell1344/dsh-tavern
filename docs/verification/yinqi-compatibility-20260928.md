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

## Explicit opening submission

At the user's request, completing the guide now stages its original prepared opening prompt in chat metadata instead of clicking the legacy send button. Reload retains the staged prompt and its lifecycle revision. Existing completed setups can use the same host button with their saved configuration. The UI states that setup is saved and no request has been sent; it shows submitting while admission is pending and submitted only after acceptance. A synchronous click guard prevents double submission, and rejection restores the button with the error.

Verification: 94 focused tests passed, including prompt staging without generation, metadata persistence without an added message, exact session/prompt dispatch, and button pending/success/failure/double-click behavior. After restarting, the real saved session displayed only the unsent status and the Generate Opening button, without the old generating claim. The gameplay model request was not triggered by this display check.

## Generic composer correction

The previous recovery button depended on exact greeting text, while completion rewrote a particular guide function. Both were incorrect compatibility boundaries. Removed the guide source replacements (including self-check overrides); the module now receives a scoped parent/top document facade for the standard `send_textarea` and `send_but` APIs. DOM ID/query lookup and jQuery composer selection resolve to the calling sandbox, and submission keeps the original session and exact text. Other host DOM access still delegates to the host. New guide completions use the original script send action. Existing system-staged messages have a host-owned “发送卡片消息” recovery control driven by their saved payload and lifecycle revision, independent of card wording. No card resource or saved message was edited.

Validation: the neutral parent-DOM reproduction failed before the fix with a missing textarea. 127 focused tests now pass (composer, renderer, metadata, session ownership, module loading and recovery-button interaction). Two neutral modules also ran in a real browser through the production module loader and foreground submission adapter: both reached the test receiver with distinct session IDs, exact text and queue mode. The browser receiver was a test double, not the game model. All nine extracted original scripts parse with the generic module scope. This does not establish full gameplay compatibility or make the card's SillyTavern-specific self-check settings equivalent to DSH settings. Existing background-model adapters were outside this sending-path correction.

After restarting the local service, opened the user's current 15:39 saved conversation in the real browser. The native message area visibly showed the saved greeting, “有一条卡片准备的消息尚未发送。” and the system button “发送卡片消息”; phone and system status UI were also present. Did not click the gameplay submission button. Saved greeting text from the previous implementation remains user data and was not rewritten.

## Shared-script presentation fragments

Reproduced the plain bubble report in the real saved conversation: the host had the card's bubble stylesheet but zero bubble nodes; thirteen message iframes isolated the replacement HTML from the host stylesheet and hydration observer. Added a generic trusted presentation-fragment path. Small allowlisted HTML fragments mount as script-owned DOM children on the host; full documents, executable content, unknown elements, untrusted mode and opening previews retain the existing iframe path. No card class names or replacement rules are used in the routing decision. Card files and saved prose remain unchanged.

Validation: 72 focused tests passed (fragment routing, host stylesheet and observer hydration, active-content fallback, message rendering and native prose). Generated client and whitespace checks passed. After service restart, the actual saved conversation had 23 bubble nodes, all 23 marked hydrated by its unmodified script, colored borders/text and emotion badges; zero message iframes and zero overflowing fragment containers at the actual 342px story-column width. Visual inspection confirmed the original reported dialogue rendered as a bubble. All 23 avatars used the card's own “未上传头像” initial fallback; image availability was not changed. No model generation was initiated by this verification.

## Native navigation and legacy layout anchors

The top card bar fell back to viewport origin because the host did not implement the standard `sheld` and `top-settings-holder` geometry anchors. Added per-sandbox virtual DOM anchors backed by the current conversation's scroll viewport. Measurements remain live; a ResizeObserver notifies legacy style/class observers when the conversation resizes. No card names or panel selectors occur in the compatibility implementation, and real host nodes are not renamed or moved.

Validation: 30 composer, resource-retention and module-loader tests passed; build/diff checks passed. In the actual browser, the desktop bar moved from viewport origin to x=280, y=82, width=414 while the native header ended at y=81.5. Collapsing the sidebar updated its x to 56 and width to 638. At 390px viewport width, the card's mobile branch also kept y=82 below the native header (the card itself uses full viewport width in this branch). Restored viewport and sidebar afterwards. No model request was made. Card-internal compact layout/wrapping remains controlled by its own stylesheet.

## Scroll position follow-up

The compatibility-only `#chat` mount participated in normal body layout. The card wrote `padding-top:46px!important` to this empty mount, increasing the real browser document from 720px to 766px while the app itself occupied a 720px viewport. Made only the system-owned mount `display:contents!important`, retaining its DOM identity and connected children without a second layout box. Existing real chat nodes are untouched. Also notify virtual layout-anchor observers on captured scroll events, coalesced with requestAnimationFrame, so position-only changes do not require ResizeObserver size changes. Cleanup disconnects observers and cancels queued notifications on frame exit.

Validation: 93 focused tests passed, including placeholder padding, live position notifications and listener cleanup. In the actual saved session, document height is now exactly 720px for a 720px viewport despite the unchanged card-written padding. Scrolled to the story bottom and then upward (scrollTop 11263.5 -> 9823.5); the bar remained at y=82 with the native header bottom at 81.5. The reported screenshot's exact larger gap did not occur in the initial browser attempt; the extra outer-page scroll range was directly observed and removed. No card content or gameplay messages were modified.


## 子代理页面遮挡与宿主节点归属

- 切到同一游戏的子代理时，继续复用根会话执行器，但按实际选中的会话隐藏卡片界面；返回根会话恢复。模板弹窗也只在根会话可见时展示。
- 实测发现原先以 body/head 新增节点推断脚本归属，会误收集原生子代理菜单，导致 React removeChild 报错。改为只管理 scoped jQuery 挂载及脚本文档代理明确创建的节点，保留宿主界面。
- 实际已有游戏连续两次“前台 → 酒馆后台 Agent → 前台”：子代理页面状态条、手机按钮均为 0，父会话入口可点击；返回后均为 1。没有新增 removeChild 错误。仅导航，没有发送消息或触发模型请求。
- 回归覆盖同根子代理与嵌套子代理、后台任务继续完成、冷开子代理、原生节点不被移走、直接 DOM 与延迟挂载的脚本节点隐藏/恢复/清理。

## 子代理下拉菜单被状态条遮挡

- 补充复现的是切换前的菜单：原生 tree portal z-index 为 100，卡片固定条为 500，实际矩形重叠。
- 系统 CSS 将原生顶层 tree/menu/listbox 导航弹层置于卡片浮层之上；脚本归属节点统一标记并排除，不修改卡片内容。
- 实际页面重叠区域 elementFromPoint 命中菜单（hitMenu=true），成功选择后台子代理并返回前台。30 项会话/节点归属测试通过，客户端构建一致性检查通过。

## 开场预览的设置持久化与旧宿主读取

预览草稿过去从空扩展设置初始化，saveTavernExtensionSettings 只改草稿，因此关闭后 MVU 模式恢复默认。现在通过同一 profile 设置模块读取和保存，保留其并发冲突检查；世界书与变量仍在开局草稿中。缺失的全局正则列表通过运行时正则投影提供，规范化人物卡同时提供旧接口所需 characters[id].data 读取路径。Session 开场桥接保留原宿主对象与设置引用，避免保存函数操作的对象与卡片读取对象分离。

未改人物卡内容，未硬编码自检结果或强制覆盖用户模式。已丢弃草稿中的历史选择不能恢复。回归 112 项通过，覆盖持久化后重新打开、旧正则/脚本读取、设置对象身份、开场选择及保留；客户端重建与一致性检查通过，服务重启完成。尚未在用户当前向导中执行一键修复并完整走完开局。

## MVU 代理设置与真实自检闭环

在原始 V24.4 卡的开场预览点“开始绑定”，复现 3 项严重：更新方式、变量更新出错通知、额外模型缺密钥。前次接口修复解决了持久化能力和列表读取，但没有修正 MVU 设置暴露的连接配置；请求已由后台代理执行，自检却仍看到旧密钥配置。

现在 MVU 的公开额外模型配置通过运行时视图返回实际后台代理入口和非秘密的 host-managed 标识；请求测试确认该入口转交 generateTavernHelperRaw。保存与序列化保留原始连接配置，MVU schema 重建设置对象时也会去掉代理占位值，避免覆盖用户原有密钥。更新方式和通知不做伪造投影，已按用户要求通过设置存储 API 保存额外模型解析与变量更新出错通知。

103 项针对性测试通过，客户端构建检查通过。重新打开原卡预览并再次点击开始绑定，真实页面显示“额外模型解析（推荐）”“已配置（本局后台模型）”，无严重错误，只剩 2 项黄色建议。未修改卡片、未启动新游戏或生成剧情。

## 旧格式脚本列表的名称读取

自检的“未找到 8 个”并非可忽略建议。执行器早已展开 {type:'script',value:{name,...}}，但 characters[id].data.extensions.TavernHelper_scripts 仍返回包装对象，自检读取顶层 name 得到 undefined。现将此只读人物卡投影按执行器同样的规则展开，并合并外层与内层启用标志；原卡不变。

新增回归先失败后通过；95 项相关测试通过。直接读取原始 V24.4 卡，通过实际 Helper facade 按卡片自检的同一路径查找，返回 9 个脚本，所需 8 个全部存在且启用（missing=[]、disabled=[]）。本轮未再次完整点击浏览器向导。
