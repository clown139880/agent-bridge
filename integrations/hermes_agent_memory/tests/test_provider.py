from __future__ import annotations

import importlib.util
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

_spec = importlib.util.spec_from_file_location("agent_bridge_memory", Path(__file__).resolve().parents[1] / "__init__.py")
plugin = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(plugin)


class FakeMcp:
    def __init__(self):
        self.calls: list[tuple[str, dict]] = []
        self.down = False
        handler = self._handler()
        self.server = HTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_port}/mcp"

    def _handler(self):
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                if fake.down:
                    self.send_response(503); self.end_headers(); return
                request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                assert self.headers["Authorization"] == "Bearer writer-token"
                name, args = request["params"]["name"], request["params"]["arguments"]
                fake.calls.append((name, args))
                result = {
                    "memory_resolve_scope": {"scope": "velvet-room" if args.get("room_id") == "!velvet:x" else "_global",
                                             "warnings": []},
                    "memory_bootstrap": {"text": f"# 全局\n\n# 作用域 {args.get('scope')}"},
                    "memory_load": {"text": f"# 自身 {args.get('scope')}"},
                }.get(name, {"ok": True, "args": args})
                body = json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": {"structuredContent": result}}).encode()
                self.send_response(200); self.send_header("Content-Length", str(len(body))); self.end_headers()
                self.wfile.write(body)

        return Handler


@pytest.fixture
def mcp(monkeypatch):
    fake = FakeMcp()
    monkeypatch.setenv("AGENT_MEMORY_URL", fake.url)
    monkeypatch.setenv("AGENT_MEMORY_TOKEN", "writer-token")
    monkeypatch.setenv("AGENT_MEMORY_SELF_SCOPE", "_agent-dorothy")
    yield fake
    fake.server.shutdown()


def test_room_scope_bootstrap_tools_and_handoff(mcp, tmp_path):
    provider = plugin.AgentBridgeMemoryProvider()
    assert provider.is_available()
    # Hermes registers tools before initialize(); write tools must already be there.
    assert "memory_write" in {tool["name"] for tool in provider.get_tool_schemas()}
    provider.initialize("s1", platform="matrix", chat_id="!velvet:x:$thread", chat_name="天鹅绒之馆",
                        hermes_home=str(tmp_path), agent_context="primary")
    assert mcp.calls[0] == ("memory_resolve_scope", {"room_id": "!velvet:x", "room_name": "天鹅绒之馆", "create": True})
    block = provider.system_prompt_block()
    assert "# 作用域 velvet-room" in block and "# 自身 _agent-dorothy" in block and "作用域 velvet-room）" in block
    assert {tool["name"] for tool in provider.get_tool_schemas()} >= {"memory_write", "memory_log", "memory_load"}

    json.loads(provider.handle_tool_call("memory_write", {"topic": "comfy", "kind": "fact", "value": "v"}))
    assert mcp.calls[-1] == ("memory_write", {"topic": "comfy", "kind": "fact", "value": "v", "scope": "velvet-room"})
    provider.handle_tool_call("memory_search", {"query": "x", "scope": "all"})
    assert mcp.calls[-1][1]["scope"] == "all"

    provider.on_session_end([{"role": "user", "content": "出一张图"}, {"role": "assistant", "content": "好"}])
    assert mcp.calls[-1][0] == "memory_search"
    turns = [m for i in range(3) for m in ({"role": "user", "content": f"第{i}句"}, {"role": "assistant", "content": f"回{i}"})]
    provider.on_session_end(turns)
    name, args = mcp.calls[-1]
    assert name == "memory_log" and args["summary"] == "会话交接：第0句（3 轮）" and "回2" in args["body"]


def test_cron_is_read_only_and_outage_uses_cache(mcp, tmp_path):
    primary = plugin.AgentBridgeMemoryProvider()
    primary.initialize("s1", platform="matrix", chat_id="!velvet:x", hermes_home=str(tmp_path))
    mcp.down = True
    offline = plugin.AgentBridgeMemoryProvider()
    offline.initialize("s2", platform="matrix", chat_id="!velvet:x", hermes_home=str(tmp_path), agent_context="cron")
    assert "# 作用域 velvet-room" in offline.system_prompt_block() and "暂不可用" in offline.system_prompt_block()
    assert json.loads(offline.handle_tool_call("memory_write", {"topic": "a", "kind": "fact", "value": "v"}))["error"]
    mcp.down = False
