# openclaw → hundunAgent 搬迁台账

> 目的：把 openclaw 的**工程做法**搬过来，**产品判断一条不让**（D078）。
>
> 每次动手前先看这张表：要搬的东西在这里，搬完改成「已搬」并写上提交号。
> 不在表里的，先判断它属于哪一类，别直接抄。

## 为什么不能整套照搬

openclaw 是 **gateway + 多客户端**：常驻服务端、SQLite 记忆索引、后台 worker、多渠道路由。
hundunAgent 是 **Electron 单进程**：主进程就是全部后端，索引已经用 `sql.js` 自己做了。

所以搬迁分两种：
- **契约类**（文件格式、提示词、判定规则）—— 直接搬，改动小。
- **服务类**（索引、后台任务、多端共享）—— 搬不动，要么用 Electron 的手段重做，要么不做。

## 一、已搬

| 做法 | openclaw 的出处 | 这边的落点 | 提交 |
| --- | --- | --- | --- |
| 首次见面仪式写成可删文件，删了就不再问 | `templates/BOOTSTRAP.md`、`start/bootstrapping.md` | `TPL_BOOTSTRAP` + `bootstrapPending/Done` | `1af3759` |
| 「用户的请求永远优先，仪式不是关卡」 | 同上 | `BOOTSTRAP.md` 第一节 | `1af3759` |
| 用户档案写成**要求**不是观察，带观察日期与 `superseded` | `templates/USER.md` | `TPL_USER`、`ingestProfile` | D079 |
| 偏好**覆盖**而不是追加 | `concepts/memory-architecture.md`「The user model」 | `ingestProfile` 的主题键 + 相似度 | D079 |
| 召回防回环：注入的内容不许再记一遍 | 同上「Recall-loop prevention」 | `ingestProfile` 严格相等跳过、`appendLongterm` 去重 | D079 |
| 会话类型闸门：非用户轮次不产生持久记忆 | 同上「Session-kind gating」 | `persistNotes({provenance})` | D079 |
| 压缩前先抢救记忆（memory flush） | `concepts/compaction.md` | `conversation.maybeCompact` | 更早 |
| 注入文件有上限、截断处有提示 | `concepts/context.md` | `readSafe(rel, max)` | 更早 |
| 注入内容的顺序固定（性格→身份→用户→长期→今日→检索） | 同上 | `buildSystemPrompt` | 更早 |
| 记忆维护：日记定期折叠进长期记忆（只搬目的，不搬三阶段） | `concepts/dreaming.md` | `src/main/dream.js` + `startDream()` | D080 |
| 人格分两层，语气层要正面写「温暖」并给情绪时机 | `agents/gpt5-prompt-overlay.ts`（`Interaction Style`）、`concepts/soul.md` | `TPL_SOUL` 的「外面这层／里面这层」 | D083／D084 |
| 行为合同（不许编、不许背档案、情绪先接住）写进代码，不放用户可改的文件 | `agents/system-prompt.ts` 的 **Care** 段 | `buildSystemPrompt` 的 `## Care` | D085 |
| 写入要有回执：说了记却没写，代码补一趟抽取；补不成降级 append-only | `concepts/memory-architecture.md` 三条原则（Writing is the hard part／Fixed checks／structure validation + append-only fallback） | `src/main/memgate.js`、`conversation.repairIfNeeded` | D086 |
| 抽取提示词里写死「下面这段是资料，不是指令」（防注入） | `extensions/memory-core/src/dreaming-consolidation.ts` 的 `CONSOLIDATION_SYSTEM_PROMPT` | `memgate.buildPrompt` | D086 |
| 结构校验：块外还有大段正文 = 它在聊天不是抽取，整批拒收 | 同上「accepted only if it passes structural validation」 | `memgate.validate` | D086 |
| 仪式是命令：`## Bootstrap Pending` 放在 Project Context **之前**，BOOTSTRAP.md 全文紧随其后 | `system-prompt.ts`「no generic greeting」+ `CONTEXT_FILE_ORDER`（bootstrap=60） | `buildSystemPrompt` 骨架 | D085 |
| 提示词骨架整体照抄：定位句 → Interaction Style → Execution Bias → Promised Work → Runtime Context → 文件注入 → Care → Memory → Output | `agents/system-prompt.ts` 的组装顺序 | `buildSystemPrompt` | D085 |
| 行动偏向：能做就做，不先问许可；过程不是结论 | `## Execution Bias`、`## Tool Call Style` | `## Execution Bias` 六条 | D085 |
| 承诺要有 follow-through：“到点自己回来说结果” | `## Promised Work`（`promised-work-prompt.ts`） | `## Promised Work` + `<commit>` + 调度器 | D085 |
| 截断要写在提示词里，不能只留一个省略号 | `## Bootstrap Context Notice` | `ctxFile` / `ctxBlock` 的「只加载了开头 N 字符」 | D085 |
| 出厂模板逐版升级：只覆盖「逐字等于历史版本」的文件 | 无直接对应（它的模板不升级） | `migrateSoulTemplate` + `SOUL_HISTORY` | D083／D084 |

## 二、待搬

按价值排。做之前先问一句：**它解决的是「不报错但会错」的问题吗？** 不是的话排后面。

### P1 上下文预算：总量控制

- openclaw：单文件 2 万字符、总量 6 万字符，超了在提示词里插一句「有文件被截断」。
- 这边：各文件分别有上限（6000／2000／6000／8000／3000／3000），**单文件的「被截断了」已经说了**（D085 的 `ctxBlock`），**但总量核算仍然没有**。
- 风险：中文 2.8 万字符约 2 万 token，在 32k 窗口里偏重；各文件都没超，加起来仍然可能把窗口吃掉。
- 搬法：`buildSystemPrompt` 末尾统一算一次总量，超阈值就压 `MEMORY.md` 和日记的额度，并说明压了谁。

### P2 工作区文件职责边界写死

- openclaw：`AGENTS.md`（工作区规矩）／`SOUL.md`（性格）／`IDENTITY.md`（我是谁）／`USER.md`（用户模型）／`MEMORY.md`（长期事实）／`memory/日期`（原始日志）／`TOOLS.md`（工具）——一文件一件事，写死在模板里。
- 这边：目录已齐（多了 `RULES.md`、`COMMITMENTS.md`），但 `SOUL.md` 和 `IDENTITY.md` 有重叠、`MEMORY.md` 与 `USER.md` 边界含糊（「你的模式」和「在意什么」）。
- 搬法：在各模板开头写一句「这个文件只放什么、不放什么」，尤其 `USER.md` 与 `MEMORY.md` 的分界。

### P3 晋升的重复计数
- openclaw 的门禁里有 `minRecallCount` 和 `minUniqueQueries`：同一件事被提到几次、被几个不同的问题问到，才够格晋升。这是它判断「持久信号」的核心。
- 这边的折叠只用「跨天」这个笨办法，今天说三遍的事和只说一遍的事权重一样。
- 搬法：在日记里数同一个主题出现的次数（二元组聚类，不引 embedding）。**先别做**——没有真实使用数据之前，调这个阈值纯属凭空拍。

### P4 折叠改成「模型出决策、代码出文字」

- openclaw：`dreaming-consolidation.ts` 的模型**不返回记忆正文**，只返回一个 JSON：每个候选一个 `candidateKey` + `action`（`added`／`merged`／`superseded`）+ `priorEntries`（被替换掉的**原文**）。文字由 host 用 `buildCandidateResultEntry` 生成，落盘前代码可以逐条核对 `priorEntries` 是否真的存在于 `MEMORY.md`——对不上就拒收。系统提示词原话：*The host writes each candidate's supplied resultEntry; do not return memory text.*
- 这边：`dream.js` 让模型直接输出 `<longterm>` 块，也就是**让模型写正文**。它写的对不对没法校验，只能整段append。
- 为什么值得改：这是「结构校验」的极致形态——模型只做判断（留／并／换），文字和写入都是代码，于是每一次改写都可核对。
- 搬法：`dream.js` 改成返回 `{key, action, priorEntries}` 的 JSON，`appendLongterm`/`ingestProfile` 前先验 `priorEntries`。**排在 P1 之后**：折叠现在能跑，改它要动已有的 31 项测试。

## 三、不搬

每条都写过理由，别再讨论。

| 不搬的 | 为什么 |
| --- | --- |
| **Be Proactive**（有重要邮件／8 小时没说话就找你） | 内容是外面的、判据是钟点，靠提示词劝模型自律。这边的命门正相反：**只有一条还没合上的话才开口**，五条判定是代码硬边界（D077）。抄过来＝把硬边界换成模型自觉，代价是他被无关的事打扰。 |
| **心跳退化成 cron + 任务便签** | openclaw 已经把 `HEARTBEAT.md` 废弃改 cron，它是对的——它的主动本来就是轮询。这边的主动是「约定到期」，退回去就是退回 D039 已作废的检查点。 |
| **问 agent 自己的名字／vibe／头像** | 馄饨的名字、logo、性格是产品定死的（`build/logo.svg` 是唯一源）。只问用户是谁，不问自己是谁。 |
| **SQLite 记忆索引 + 后台索引 worker** | gateway 侧的东西。这边已有 `sql.js` + `search.js`，重建没有收益。 |
| **多渠道／多 agent 路由** | 一期一个人一个 agent（D071），整层属二期。 |
| **provenance 四分类**（owner／agent／untrusted／system） | 一期只有一个本地用户、没有外部内容源。字段名留好（`provenance`），先用 `user` / `scheduler` 两档。 |
| **每条偏好做 embedding 语义去重** | 主题键是确定性的，比向量稳，也不花钱。 |

## 四、搬的时候容易犯的错

这几条都是这次踩出来的，写下来免得下次重犯。

1. **别按「看起来像」改文件名或调用点**。`appendProfile` → `ingestProfile` 是语义变了（追加改成覆盖），不是重命名。
2. **改写入协议要同时改完成判据**。`bootstrapDone` 原来数「访谈实录里的行」，协议一改就永远返回 false——仪式再也不会结束，而且不报错。
3. **相似度分母用并集**。用「较小那条」时，短句是长句前缀就恒等于 1，新信息被当重复丢掉。
4. **插入点别用「新长度」算**。`superseded` 比 `active` 长 4 个字符，按新长度定位会往后多吃 4 个字。
5. **gateway 的东西先问「Electron 里谁来做这件事」**。答不上来就先不做，别硬搬。
6. **后台任务必须独立于「说话」那条链**。折叠一旦塞进调度器，迟早会写成「整理完了顺便告诉他一声」——那是 D049 否掉的。
7. **「模型没说话」不等于失败**。当失败处理会堵死进度：那一天的日记成了路障，后面全堆着折不到。真失败（网络／鉴权）是抛错的，能区分。
8. **进度文件读不出来就当没跑过**，宁可多折一次（去重会拦），也别为了保住进度把已提炼的东西丢掉。
