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

## 二、待搬

按价值排。做之前先问一句：**它解决的是「不报错但会错」的问题吗？** 不是的话排后面。

### P1 记忆维护：定期把日记折叠进长期记忆

- openclaw 的做法：`dreaming` 三阶段（light / REM 先暂存候选、不碰长期记忆；最后才做一次受门禁的合并），产物写进 `MEMORY.md` / `USER.md`，另出一份人类可读的 `DREAMS.md`。
- 这边现状：**日记只增不减，`MEMORY.md` 只增不减，没有任何东西管合并**。跑三个月，`MEMORY.md` 会变成第二份日记。
- 搬法：不做三阶段，只搬**目的**——攒够若干天、且此刻不打扰他时，让模型把日记里「持久的事实／有证据的判断」提炼进 `MEMORY.md`，旧的日记不动（只写不删）。
- 硬约束：
  - **不能借机开口**。这是后台活，做完不出声。
  - 一次只处理一段日期，写失败就跳过，不重试到天亮。
  - 提炼结果同样走 `appendLongterm` 的去重，别把复读再灌一遍。

### P2 上下文预算：总量控制

- openclaw：单文件 2 万字符、总量 6 万字符，超了在提示词里插一句「有文件被截断」。
- 这边：各文件分别有上限（6000／2000／6000／8000／3000／3000），**但没有总量核算**，也没有「被截断了」的提示。
- 风险：中文 2.8 万字符约 2 万 token，在 32k 窗口里偏重；`readSafe` 截断时模型不知道自己看到的是残篇。
- 搬法：`buildSystemPrompt` 末尾统一算一次总量，超阈值就压 `MEMORY.md` 和日记的额度，并在注入内容里加一行明确的截断说明。

### P3 工作区文件职责边界写死

- openclaw：`AGENTS.md`（工作区规矩）／`SOUL.md`（性格）／`IDENTITY.md`（我是谁）／`USER.md`（用户模型）／`MEMORY.md`（长期事实）／`memory/日期`（原始日志）／`TOOLS.md`（工具）——一文件一件事，写死在模板里。
- 这边：目录已齐（多了 `RULES.md`、`COMMITMENTS.md`），但 `SOUL.md` 和 `IDENTITY.md` 有重叠、`MEMORY.md` 与 `USER.md` 边界含糊（「你的模式」和「在意什么」）。
- 搬法：在各模板开头写一句「这个文件只放什么、不放什么」，尤其 `USER.md` 与 `MEMORY.md` 的分界。

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
