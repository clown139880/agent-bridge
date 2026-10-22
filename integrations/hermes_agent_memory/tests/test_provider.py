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
        self.url = f"http://127.0.0.1:{self.server.server_port}/mcp/memory"

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
                assert "text/event-stream" in self.headers["Accept"]
                name, args = request["params"]["name"], request["params"]["arguments"]
                fake.calls.append((name, args))
                result = {
                    "scope": {"scope": "velvet-room" if args.get("room_id") == "!velvet:x" else "_global",
                                             "prefetch": args.get("room_id") == "!velvet:x", "warnings": []},
                    "search": {"hits": [{"scope": "velvet-room", "text": "工作流/fact = 新值"},
                                               {"scope": "_global", "text": "已注入/fact = 作用域 velvet-room"}]}
                    if args.get("mode") == "recall" else {"ok": True, "args": args},
                    "bootstrap": {"text": f"# 全局\n\n# 作用域 {args.get('scope')}"},
                    "load": {"text": f"# 自身 {args.get('scope')}"},
                }.get(name, {"ok": True, "args": args})
                reply = {"jsonrpc": "2.0", "id": request["id"], "result": {"structuredContent": result}}
                if name == "write" and args.get("topic") == "broken":
                    reply["result"] = {"isError": True, "content": [{"type": "text", "text": "invalid_topic: bad slug"}]}
                body = f"event: message\ndata: {json.dumps(reply)}\n\n".encode()
                self.send_response(200); self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(body))); self.end_headers()
                self.wfile.write(body)

        return Handler


@pytest.fixture
def mcp(monkeypatch):
    fake = FakeMcp()
    monkeypatch.setenv("AGENT_MEMORY_URL", fake.url)
    monkeypatch.setenv("AGENT_TOKEN", "writer-token")
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
    assert mcp.calls[0] == ("scope", {"room_id": "!velvet:x", "room_name": "天鹅绒之馆", "create": True})
    block = provider.system_prompt_block()
    assert "# 作用域 velvet-room" in block and "# 自身 _agent-dorothy" in block and block.startswith("长期记忆（当前房间：velvet-room；")
    assert {tool["name"] for tool in provider.get_tool_schemas()} >= {"memory_write", "memory_load"}
    assert "memory_log" not in {tool["name"] for tool in provider.get_tool_schemas()}

    json.loads(provider.handle_tool_call("memory_write", {"topic": "comfy", "kind": "fact", "value": "v"}))
    assert mcp.calls[-1] == ("write", {"topic": "comfy", "kind": "fact", "value": "v", "scope": "velvet-room"})
    provider.handle_tool_call("memory_search", {"query": "x", "scope": "all"})
    assert mcp.calls[-1][1]["scope"] == "all"
    assert json.loads(provider.handle_tool_call("memory_write", {"topic": "broken", "kind": "fact", "value": "v"})) \
        == {"error": "invalid_topic: bad slug"}

    recalled = provider.prefetch("上次那个工作流怎么配的")
    assert mcp.calls[-1] == ("search", {"query": "上次那个工作流怎么配的", "scope": "velvet-room,_global",
                                               "mode": "recall", "limit": 5})
    assert "工作流/fact = 新值" in recalled and "已注入" not in recalled
    assert provider.prefetch("/new") == ""

    calls = len(mcp.calls)
    turns = [m for i in range(3) for m in ({"role": "user", "content": f"第{i}句"}, {"role": "assistant", "content": f"回{i}"})]
    provider.on_session_end(turns)  # base-class no-op: no automatic hand-off
    assert len(mcp.calls) == calls


def test_cron_is_read_only_and_outage_uses_cache(mcp, tmp_path):
    primary = plugin.AgentBridgeMemoryProvider()
    primary.initialize("s1", platform="matrix", chat_id="!velvet:x", hermes_home=str(tmp_path))
    mcp.down = True
    offline = plugin.AgentBridgeMemoryProvider()
    offline.initialize("s2", platform="matrix", chat_id="!velvet:x", hermes_home=str(tmp_path), agent_context="cron")
    assert "# 作用域 velvet-room" in offline.system_prompt_block() and "暂不可用" in offline.system_prompt_block()
    assert json.loads(offline.handle_tool_call("memory_write", {"topic": "a", "kind": "fact", "value": "v"}))["error"]
    mcp.down = False


def test_skill_index_lists_room_skills_and_pinned_only(monkeypatch):
    skills = [
        {"name": "room-skill", "scope": "jmyd", "description": "房间技能", "pinned": False},
        {"name": "mine", "scope": "_agent-dorothy", "description": "自己的", "pinned": True},
        {"name": "global-pinned", "scope": "_global", "description": "置顶", "pinned": True},
        {"name": "global-other", "scope": "_global", "description": "不置顶", "pinned": False},
    ]
    provider = plugin.AgentBridgeMemoryProvider()
    provider._skill_scopes, provider._self_scope = "all", "_agent-dorothy"
    monkeypatch.setattr(provider, "_call", lambda tool, args: {"skills": skills})
    provider._scope = "jmyd"
    block = provider._skill_index()
    assert "- room-skill:" in block and "- mine:" in block and "- global-pinned:" in block
    assert "global-other" not in block and "1 more skills" in block
    provider._scope = "_global"  # a DM: _global is not a room
    block = provider._skill_index()
    assert "- mine:" in block and "- global-pinned:" in block
    assert "global-other" not in block and "room-skill" not in block and "2 more skills" in block


def test_dm_reads_and_writes_the_shared_scope(mcp, tmp_path, monkeypatch):
    monkeypatch.setenv("AGENT_MEMORY_SHARED_SCOPE", "_assistants")
    provider = plugin.AgentBridgeMemoryProvider()
    provider.initialize("s1", platform="matrix", chat_id="!dm:x", hermes_home=str(tmp_path), agent_context="primary")
    block = provider.system_prompt_block()
    assert "# 作用域 _global" in block and "# 自身 _assistants" in block and "# 自身 _agent-dorothy" in block
    provider.handle_tool_call("memory_write", {"topic": "nas", "kind": "fact", "value": "v"})
    assert mcp.calls[-1][1]["scope"] == "_assistants"
    provider.handle_tool_call("memory_write", {"topic": "me", "kind": "profile", "value": "v", "scope": "_global"})
    assert mcp.calls[-1][1]["scope"] == "_global"
    provider.handle_tool_call("memory_search", {"query": "x"})
    assert mcp.calls[-1][1]["scope"] == "_assistants,_global"
    # A room keeps its own scope as the default.
    room = plugin.AgentBridgeMemoryProvider()
    room.initialize("s2", platform="matrix", chat_id="!velvet:x", hermes_home=str(tmp_path), agent_context="primary")
    room.handle_tool_call("memory_write", {"topic": "a", "kind": "fact", "value": "v"})
    assert mcp.calls[-1][1]["scope"] == "velvet-room"
    assert "# 自身 _assistants" in room.system_prompt_block()
