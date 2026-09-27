"""Capture the EXACT HTTP body the real client sends for a compaction call."""
import json, sys, threading
from http.server import BaseHTTPRequestHandler, HTTPServer
sys.path.insert(0, '.')
from agent.llm.llm_clients.openai_client import OpenaiLlmClient
from agent.core.compaction import Compactor
from agent.core.lazy import LazyEventLog
from agent.events import UserMessageEvent, AssistantMessageEvent
from agent.config import Config

captured = {}

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        n = int(self.headers.get('content-length', 0))
        body = json.loads(self.rfile.read(n))
        captured['body'] = body
        # stream a compliant summary
        chunks = [
            {"id":"1","object":"chat.completion.chunk","created":0,"model":"m",
             "choices":[{"index":0,"delta":{"content":"## Objective\n- x\n"},"finish_reason":None}]},
            {"id":"1","object":"chat.completion.chunk","created":0,"model":"m",
             "choices":[{"index":0,"delta":{},"finish_reason":"stop"}]},
        ]
        payload = "".join("data: "+json.dumps(c)+"\n\n" for c in chunks) + "data: [DONE]\n\n"
        self.send_response(200)
        self.send_header('Content-Type','text/event-stream')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload.encode())

srv = HTTPServer(('127.0.0.1', 0), H)
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()

llm = OpenaiLlmClient(api_key="k", base_url=f"http://127.0.0.1:{port}/v1", model="test-model")
log = LazyEventLog.in_memory()
log.append(UserMessageEvent(content="ORIGINAL REQUEST 中文"))
for i in range(5):
    log.append(AssistantMessageEvent(content=f"step {i} " + "y"*200))
comp = Compactor(Config(llm_context_window_bytes=100), log, llm)
print("compact ->", comp.compact())
b = captured['body']
print("KEYS:", sorted(b.keys()))
print("TOOLS present:", 'tools' in b)
print("MESSAGES count:", len(b['messages']))
for m in b['messages']:
    print("  role:", m['role'], "len:", len(m.get('content') or ''))
    print("  content head:", repr((m.get('content') or '')[:300]))
    print("  content tail:", repr((m.get('content') or '')[-200:]))
