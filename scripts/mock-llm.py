#!/usr/bin/env python3
"""
本地假模型服务，仅用于联调：
    python3 scripts/mock-llm.py 8787
然后把设置里的接口地址填 http://127.0.0.1:8787/v1

为什么用 Python 而不是 Node：本机 Node 的 HTTP 栈依赖 WASM，跑服务端会直接 OOM。
它真的按 OpenAI 的 SSE 格式逐字吐，所以能验证流式、记忆块提取、落盘全链路。
"""
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8787

OPENING = "在。先问一个：你现在主要在忙什么？"

FOLLOWUP = (
    "嗯，写代码的。\n\n"
    "那你一天里最长的那段不被打断的时间，大概是几点到几点？\n"
    "<memory>\n- 主要做开发\n</memory>"
)

DEFAULT = "记下了。今天想先动哪一件？"


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def log_message(self, *args):
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8"))
        except Exception:
            payload = {}

        msgs = payload.get("messages") or []
        user_turns = sum(1 for m in msgs if m.get("role") == "user")
        last = ""
        for m in reversed(msgs):
            if m.get("role") == "user":
                last = str(m.get("content") or "")
                break

        if "开始对话" in last or "检查点" in last:
            reply = OPENING
        elif user_turns <= 2:
            reply = FOLLOWUP
        else:
            reply = DEFAULT

        if not payload.get("stream"):
            body = json.dumps(
                {
                    "choices": [{"message": {"role": "assistant", "content": reply}}],
                    "usage": {"prompt_tokens": 100, "completion_tokens": 50},
                }
            ).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()

        for i in range(0, len(reply), 5):
            piece = reply[i : i + 5]
            data = json.dumps({"choices": [{"delta": {"content": piece}}]}, ensure_ascii=False)
            try:
                self.wfile.write(("data: " + data + "\n\n").encode("utf-8"))
                self.wfile.flush()
            except Exception:
                return
            time.sleep(0.03)

        try:
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
        except Exception:
            pass


if __name__ == "__main__":
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"mock llm on http://127.0.0.1:{PORT}/v1", flush=True)
    srv.serve_forever()
