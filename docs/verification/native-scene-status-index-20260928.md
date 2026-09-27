# 原生图片状态按楼层查询（2026-09-28）

## 问题与设计

万轮状态栏等待的主因之一是可见正文同时查询场景图片状态。此前每批查询都读取全部历史正文，并为每个目标楼层序列化、哈希其全部正文前缀。诊断正常样本 run-WVOge7 为 38.762 秒，临时跳过图片请求的对照 run-6GqXnt 为 14.758 秒。

原生存档现在保存 sceneIndexRef 和 sceneIndexRevision。索引映射轮次到消息位置；每个消息页保存计算既有图片 key 所需的 SHA-256 前缀续算状态、目标 key 和最近助手位置。查询读取指定楼层及最新助手元数据，不读取历史正文或变量。参考图仅额外查询授权记录涉及的端点，且固定同一存档版本。

没有更换图片 key 算法：仍是 `SHA256(JSON.stringify([chat.id, prefix, index, turn, swipeId, sourceDigest]))`。scene-prefix-hash.js 的可序列化 SHA 状态用于续算此原有字节流；与 Node crypto 的块边界、分片、UTF-8 结果做差分验证。这是内容索引，不用于认证。

初次创建索引为 O(历史正文体积)。普通追加从上一条的哈希状态继续，变量更新复用原索引；修改早期正文会重建受影响后缀，因为旧图片身份本来就依赖此前正文。点查询成本取决于索引深度和目标正文大小，不再扫描 N 条历史；不宣称严格所有操作 O(1)。

索引与消息在同一 head CAS 发布。索引元数据更新不计入 Helper 消息变更集合，避免将无正文变化的后续消息错误传给浏览器。索引版本必须等于 Chat 版本；旧原生存档缺索引、或旧写入器留下过期索引时完整回退，后续写入补建。旧 JSON/JSONL 路径保留原行为。首次补索引仍可能昂贵，不能与已有索引的常规查询混为一谈。

## 兼容性和测试

覆盖冷启动点查询、旧图片 key 精确一致、追加续算、变量写入复用索引、历史正文修改、swipe/缺失 swipe 回退、截断与新分支、固定旧版本读取、旧索引缺失/失效恢复。图片服务验证关闭生图仍显示已有图片，改写前文不误挂旧图，恢复原文能再次读取旧图。

另覆盖原生存储、MVU 增量变更与事务、Conversation State、场景生成及引用、Session reader 和 registry。仅性能测试 loader 记录 point/full 读取；正式代码没有诊断日志。新增 `TAVERN_PERF_REQUIRE_SCENE_INDEX=1` 可严格要求打开时图片查询不得全历史读取。

## 实测及边界

同规格 10000 轮、19999 消息、391573697 字节、三字段变量，真实隔离 DSH + Chromium + 官方 MVU，图片功能正常开启查询。计时期间不并行构建或单元测试。

首次实现样本 run-VTjEbN：状态栏就绪 13.326 秒（对比诊断基线 38.762 秒），重新结算至可见 5.649 秒，MVU 浏览器完成至持久化 1.088 秒；完整 E2E 及重启核对通过。单次样本不等于稳定分位数。

额外 CPU 采样 run-mm3haW：打开 14.533 秒。整个冷启动进程采样中，DSH token-meter 自身代码约 7.215 秒，client-modules 约 5.732 秒，后者包含启动打包时间，不能全部计入打开阶段。代码确认 contextBreakdown 每个历史 surface 事件都复制累计 nodes，并 findLast 扫描系统消息；turnOutline 也复制累计数组。它们是剩余宿主初始化工作，本轮未修改宿主内部协议。状态栏与完整宿主初始化尚未完全解耦，整体打开 O(1) 目标仍未达标。

最终严格 E2E：run-Mp1NU1，状态栏就绪 **13.734 秒**，打开期图片点查询 **25 次**、全历史图片读取 **0 次**；重新结算至可见 **5.631 秒**，MVU 浏览器完成至持久化 **1.160 秒**。MVU 整档读取禁止断言、按需历史访问检查、服务重启后的变量核对均通过。对比诊断基线，状态栏等待减少约 65%；结算本身未变快，不能将打开优化宣称为结算性能提升。

最终相关回归 **158/158** 通过，无跳过；补充的原生参考图端点/分支校验也通过。客户端生成文件检查和 git diff --check 通过。临时服务端 CPU profiler 已移除，仅保留 E2E 的 point/full 读取计数。

复现最终样本：

```sh
TAVERN_PERF_REQUIRE_SCENE_INDEX=1 TAVERN_PERF_ROUNDS=10000 TAVERN_PERF_FIELDS=2 TAVERN_PERF_RUNS=1 TAVERN_PERF_HISTORY_READY=1 TAVERN_PERF_BODY_REPEATS=60 TAVERN_PERF_REQUIRE_LAZY=1 TAVERN_E2E_TIMEOUT_MS=120000 node tests/e2e/gameplay.mjs --native-format --settlement-performance --history-demand
```
