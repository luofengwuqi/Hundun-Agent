# 馄饨 Agent · 对话与工程存档

整理时间：2026-11-03 21:09

> **本地归档位置（2026-11-03 21:21 同步）**
> 本文件与三份对话记录现位于 `E:\code2\hundunAgent\docs\对话记录\2026-11-03\`；
> 下方所说的 `源码/` 已上提为工程根 `E:\code2\hundunAgent\`，即根目录直接就是源码树。
> 因此「源码怎么跑」一节里的 `cd 源码` 应改为在工程根执行。
> 另：`package.json` 里的 `@esbuild/linux-x64`、`@rollup/rollup-linux-x64-gnu` 与
> `build:linux` 目标都是按 Linux 写的，在 Windows 上首次 `npm install` 需要换平台包。

## 这里面有什么

| 文件 | 说明 |
|---|---|
| `对话全文.md` | **先看这个**。只留你说的话和我的回复，去掉了所有工具调用和系统注入的内容。37 KB。 |
| `完整过程.md` | 加上每一次工具调用与结果，可追溯每一步做了什么、哪一步失败了。101 KB。 |
| `原始记录.jsonl` | WorkBuddy 的原始会话数据，原样拷了一份。将来想换别的工具重新导出，靠它。 |
| `源码/` | 馄饨 Agent 的工程源码（不含 node_modules，484 KB）。要跑起来先 `npm install` 再 `npm run dev`。 |

## 这场对话走到了哪里

从「帮我做一个能了解我情况、指导我工作休息的 agent」开始，中间经过了三次方向调整：

1. **一开始想做 WorkBuddy 里的专家包** —— 摸清专家包只是纯文本人格、没有记忆也没有定时器，方案被否。
2. **改成 skill + 状态文件 + 定时自动化的三件套** —— 参考了 OpenClaw 的 `SOUL.md / MEMORY.md / memory/YYYY-MM-DD.md` 体系，但砍掉了它过强的工具性。
3. **最终定为独立 Electron 桌面应用** —— 这样 OpenClaw 那两个在 WorkBuddy 里做不到的机制（常驻心跳、上下文压缩前静默写记忆）都能真正实现。

## 定下来的设计

- **名字**：馄饨。它自称馄饨，不叫「助手」。
- **记忆**：全部放在 `~/life/` 的 Markdown 文件里，人可读、可手改、可 git。`SOUL.md`（它怎么说话）→ `IDENTITY.md` → `USER.md`（关于你）→ `MEMORY.md`（长期结论）→ `memory/YYYY-MM-DD.md`（每日流水）→ `CHECKPOINTS.md`（主动开口的时机）。
- **记忆是三层**：日记流水 → 蒸馏进 `MEMORY.md` → 更早的日子不塞进上下文，靠检索按当前话题捞回来。这是「记得第一天」的机制。
- **索引**：SQLite（sql.js，纯 WASM）只做全文检索，`.index/memory.sqlite` 随时可删，删了不丢任何记忆。Markdown 是唯一事实来源。
- **模型**：OpenAI 兼容协议，自己填 Base URL + API Key，Key 只存本地。
- **主动性**：托盘常驻 + 两个检查点（早 08:30 定计划、晚 21:30 收工复盘）+ 一个「今天别烦我」开关。
- **界面**：聊天为主，右侧可拉出记忆面板，记忆可读、可改、可保存、可搜。视觉沿用 HundunDesktop 的奶油白 `#FFF8E8` + 朱红 `#C3272B`。

## 环境上的两个真问题（换机器要重新确认）

- 这台机器的虚拟内存硬限制是 4 GB 且不可提升，导致：**任何 WASM 都起不来**（undici、sql.js 都会 OOM），**Electron 本身也起不来**（连最小应用都 SIGTRAP）。
- 所以本次开发没法真机截图，验证方式是：单元测试 52 项、连假模型服务的端到端对话 12 项、SQL 语义 10 项（交给 Python 原生 sqlite3 验）、以及 `preview.html` 静态样张。

## 源码怎么跑

```bash
cd 源码
npm install
npm run dev     # 需要桌面环境
```

第一次进去点「设置」填 Base URL + API Key（DeepSeek / Kimi / 通义 / OpenRouter 都兼容），点测试连接。然后它会主动开口，五轮访谈把 `USER.md` 填实。

## 还没做完的

- 打包成 AppImage / deb（`npm run build:linux` 的配置已写好，未实际验证）
- sql.js 那层的 JS 胶水没在真机验证过（本机 WASM 起不来），设置了自动降级到文件扫描
- 界面细节需要在你机器的真实字体和缩放上过一遍
