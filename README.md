# 馄饨（HundunAgent）

一个**有长期记忆**的桌面伙伴。不是助手，不是待办工具。

它是**独立应用**：自己持有窗口、进程、模型连接和本地数据，**不依托任何平台运行**，也不作为任何平台的插件／技能／专家包分发。

它只做两件事：**记得你说过的话**，和在合适的时候**提一句**——而且只提它记得的那一句，不凭时间打卡。

- Electron 28 + Vue 3，纯本地运行，只和一个模型 API 通信
- 记忆是 `~/life/` 下的一批 Markdown 文件，**唯一事实来源**，可以直接用编辑器改
- 索引 `~/life/.index/memory.sqlite` 只是缓存，删了不丢记忆

---

## 状态：半成品，别当成能用的软件

**这个仓库是代码骨架，不是可用版本。**

- 窗口、托盘、流式对话、记忆块解析与落盘、本地检索、设置页——这些跑通过
- **打扰（主动开口）那部分还是旧形态**：按钟点触发，不是按"你答应过的一件事"。整套要重写
- **界面从未在真机确认过**，只有静态样张 `preview.html`
- 完整规格与决策记录在 **`docs/prd/`**（PRD v0.16：71 条决策、F01–F14、126 条验收、实现计划 P-01～P-29）。**代码落后于规格**
- **一期只有一个用户、一个智能体**（D071）：登录、切换、群聊、QQ 接入整层属二期。身份目录 `~/life/users/<用户>/agents/<agent>/` 保留着，一期固定用默认身份，界面上看不到

如果你是想找个能用的桌面 AI 助手，这里不合适。

---

## 跑起来

```bash
npm install
npm run dev
```

**已知坑（Windows/macOS 第一次必踩）**：`devDependencies` 里只有 Linux 的原生包（`@esbuild/linux-x64`、`@rollup/rollup-linux-x64-gnu`），其他平台 `npm install` 会失败或装不上对应二进制。按报错补当前平台的包即可。

```bash
npm run build          # 只构建，产出 out/
npm run build:linux    # 打 Linux 包（AppImage / deb）
node scripts/test-e2e.mjs   # 端到端自测（配 scripts/mock-llm.py 假模型）
```

**截图验证**：`HUNDUN_SHOT=/tmp/a.png npm start` 会在页面加载后截一张图再退出。

## 配置

API Key、模型、温度存在系统 userData 目录的 `config.json`（权限 0600），**不在仓库里**。换机器要重新填。

`.gitignore` 已排除 `node_modules/`、`out/`、`dist/`、`data/`、`*.db`、`.env*`、`config.json`、`*.key`。提交前不确定就先 `git status` 看一眼。

---

## 目录

```
src/main/         主进程
  index.js          窗口、托盘、IPC、调度
  conversation.js   一轮对话：拼上下文 → 调模型 → 解析记忆块 → 落盘
  life.js           ~/life/ 读写、种子文件、日记追加
  blocks.js         解析回复里的 <memory> / <longterm> / <profile>
  search.js         检索（sql.js，带文件扫描兜底）
  store.js          config.json
  llm.js            模型调用与流式
src/renderer/     Vue 界面（单窗口、无路由）
scripts/          构建（esbuild）、图标生成、测试脚手架
docs/prd/         规格与决策记录（见下）
```

## 文档

`docs/prd/` 是这套东西的真实来源。**代码是它的一个落后实现**，两者冲突时以文档为准。

| 文件 | 是什么 |
| --- | --- |
| `00-CONTEXT.md` | 从哪读起。当前状态 + 历轮前情，换人换设备时先看这个 |
| `02-DECISIONS-AND-QUESTIONS.md` | 70 条决策（D001–D070）与 27 个问题（全部已答）。**权威台账** |
| `03-PRD-DRAFT.md` | 产品需求：14 个功能模块、126 条可判定验收、追溯表 |
| `04-INTERVIEW-LOG.md` | G01–G09 九轮访谈的**原话实录**。决策的来源都在这里 |
| `05-DEV-PLAN.md` | 实施计划 P-01～P-29，含「不修就白做」的顺序理由 |

`docs/对话记录/` 是立项期间的会话存档，其中 `原始记录.jsonl` 是完整的工具调用日志（3.1 MB），保留它是为了可回溯，不是为了阅读。

**文档里有一件事要先说清**：`04-INTERVIEW-LOG.md` 记录的是一个人在访谈里对助手说的话，包含他怎么描述自己的作息、情绪和判断标准。它是产品设计的证据，不是要公开的素材。

**为什么不用 Vite**：开发机 Node 虚拟内存被限制在 4GB，Vite 一加载就 OOM。esbuild 是原生二进制、`@vue/compiler-sfc` 是纯 JS，都不碰 WASM。

---

## 设计上唯一要紧的一条

**没有可说的东西，它就闭嘴。**

不允许"每天问候一次"，也不允许"统计你完成了几个约定"。它开口的依据只能是你自己说过的一句还没合上的话——因为按日历开口的软件，第一周是温暖，第十天就是噪音。

MIT License.
