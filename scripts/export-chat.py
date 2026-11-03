#!/usr/bin/env python3
"""
把 WorkBuddy 的会话 jsonl 整理成可读文档。

用法：
    python3 scripts/export-chat.py <会话.jsonl> <输出目录>

产出：
    <输出目录>/对话全文.md      —— 只留你和我真说的话（推荐先看这个）
    <输出目录>/完整过程.md      —— 加上每一次工具调用与结果（可追溯）
    <输出目录>/原始记录.jsonl   —— 原始数据，原样拷一份
"""
import json
import os
import re
import shutil
import sys
from datetime import datetime


def clean_user_text(text):
    """去掉系统注入的上下文，只留用户真正打的字"""
    # <system-reminder> 整块剥掉
    text = re.sub(r"<system-reminder[\s\S]*?</system-reminder>", "", text)
    # 只留 <user_query> 里的内容（其余都是框架塞的）
    m = re.search(r"<user_query>([\s\S]*?)</user_query>", text)
    if m:
        text = m.group(1)
    else:
        text = re.sub(r"</?user_query>", "", text)
        text = re.sub(r"<manually_attached_skills[\s\S]*?</manually_attached_skills>", "", text)
        text = re.sub(r"<connector-status[\s\S]*?</connector-status>", "", text)
        text = re.sub(r"<task-notification>[\s\S]*?</task-notification>", "", text)
    # skill 引用标记
    text = re.sub(r"@skill:[a-zA-Z0-9_-]+", "", text)
    # 后台任务失败通知被框架转成了用户消息，正文里只剩这句指令，不是用户说的话
    if re.match(r"^\s*Use the TaskOutput tool with task_id=", text):
        return ""
    return text.strip()


def load(path):
    items = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                items.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return items


def fmt_time(ms):
    try:
        return datetime.fromtimestamp(ms / 1000).strftime("%H:%M:%S")
    except Exception:
        return ""


def fmt_day(ms):
    try:
        return datetime.fromtimestamp(ms / 1000).strftime("%Y-%m-%d")
    except Exception:
        return "未知日期"


def text_of(msg):
    """从 message.content 里抽纯文本"""
    out = []
    for part in msg.get("content") or []:
        if isinstance(part, str):
            out.append(part)
        elif isinstance(part, dict):
            if part.get("type") in ("input_text", "output_text", "text"):
                out.append(part.get("text") or "")
    return "".join(out)


def brief_args(name, args):
    """把工具参数压成一行，别让文档被 JSON 淹掉"""
    if not isinstance(args, dict):
        s = str(args)
    else:
        bits = []
        for k in ("file_path", "path", "pattern", "command", "query", "skill", "toolName", "url"):
            if args.get(k):
                v = str(args[k]).replace("\n", " ")
                if len(v) > 90:
                    v = v[:90] + "…"
                bits.append(f"{k}={v}")
        s = " ".join(bits) or json.dumps(args, ensure_ascii=False)[:120]
    return s


def write_doc(items, out_md, with_tools, title):
    lines = []
    lines.append(f"# {title}\n")
    lines.append("> 由 `scripts/export-chat.py` 从原始会话记录生成。\n")

    # 元信息
    sess = next((i for i in items if i.get("type") == "ai-title"), None)
    msgs = [i for i in items if i.get("type") == "message"]
    first_ts = msgs[0]["timestamp"] if msgs else 0
    last_ts = msgs[-1]["timestamp"] if msgs else 0
    model = ""
    for i in items:
        pd = i.get("providerData") or {}
        if pd.get("model"):
            model = pd.get("model")
            break

    lines.append("| 项 | 值 |")
    lines.append("|---|---|")
    lines.append(f"| 标题 | {sess.get('aiTitle', '') if sess else ''} |")
    lines.append(f"| 起始 | {fmt_day(first_ts)} {fmt_time(first_ts)} |")
    lines.append(f"| 结束 | {fmt_day(last_ts)} {fmt_time(last_ts)} |")
    lines.append(f"| 模型 | {model} |")
    lines.append(f"| 发言轮次 | {len(msgs)} |")
    if with_tools:
        lines.append(f"| 工具调用 | {sum(1 for i in items if i.get('type') == 'function_call')} |")
    lines.append("\n---\n")

    cur_day = None
    for it in items:
        t = it.get("type")
        ts = it.get("timestamp") or 0
        day = fmt_day(ts)

        if t == "message":
            role = it.get("role")
            text = text_of(it)
            if role == "user":
                text = clean_user_text(text)
                if not text:
                    continue
                if day != cur_day:
                    lines.append(f"\n## {day}\n")
                    cur_day = day
                lines.append(f"### 🧑 你 · {fmt_time(ts)}\n")
                lines.append(text + "\n")
            elif role == "assistant":
                text = text.strip()
                if not text:
                    continue
                if day != cur_day:
                    lines.append(f"\n## {day}\n")
                    cur_day = day
                lines.append(f"### 🍜 馄饨/助手 · {fmt_time(ts)}\n")
                lines.append(text + "\n")

        elif t == "function_call" and with_tools:
            name = it.get("name") or "?"
            args = it.get("arguments")
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except Exception:
                    pass
            lines.append(f"- `{fmt_time(ts)}` **{name}** · {brief_args(name, args)}")

        elif t == "function_call_result" and with_tools:
            status = it.get("status") or ""
            out = it.get("output") or {}
            txt = out.get("text") if isinstance(out, dict) else str(out)
            txt = (txt or "").replace("\n", " ")
            if len(txt) > 200:
                txt = txt[:200] + "…"
            flag = "✓" if status == "completed" else "✗"
            lines.append(f"  - {flag} {txt}")

    with open(out_md, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    return out_md


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    src, outdir = sys.argv[1], sys.argv[2]
    os.makedirs(outdir, exist_ok=True)

    items = load(src)
    sess = next((i for i in items if i.get("type") == "ai-title"), None)
    title = (sess or {}).get("aiTitle") or "对话记录"

    write_doc(items, os.path.join(outdir, "对话全文.md"), False, title + "（对话全文）")
    write_doc(items, os.path.join(outdir, "完整过程.md"), True, title + "（完整过程）")
    shutil.copyfile(src, os.path.join(outdir, "原始记录.jsonl"))

    print("已生成：")
    for n in ("对话全文.md", "完整过程.md", "原始记录.jsonl"):
        p = os.path.join(outdir, n)
        print(f"  {n}  {os.path.getsize(p)/1024:.1f} KB")


if __name__ == "__main__":
    main()
