"""Hermes memory provider backed by the Agent Bridge Control Plane memory MCP.

Memory lives as Markdown in one scope per Matrix room or project (design:
docs/agent-memory-design.zh.md). This provider resolves the scope from the
gateway ``chat_id``, injects a fixed core-memory block at session start (so the
prompt cache stays warm), and forwards memory_* tools to the /mcp/memory tools.
It never writes files itself and records nothing on its own when a session ends.

Configuration (profile .env):
  AGENT_TOKEN              this agent's token from the Control Plane AGENT_TOKENS (required; old name AGENT_MEMORY_TOKEN)
  AGENT_MEMORY_URL         default http://127.0.0.1:8787/mcp/memory
  AGENT_MEMORY_SELF_SCOPE  optional hidden scope with this agent's own rules (e.g. _agent-dorothy)
  AGENT_MEMORY_SHARED_SCOPE optional hidden scope shared by the assistants (e.g. _assistants); a DM's
                           default for reads and writes, so _global keeps only what every agent should know
  AGENT_MEMORY_MACHINE_ID  machine id for cwd-based scopes on the CLI (default hal)
  AGENT_SKILLS_SCOPES      scopes whose skill list comes from the shared skill library (comma list or "all");
                           pairs with the agent-bridge-skills plugin (docs/agent-skills-design.zh.md)
"""
from __future__ import annotations

import hashlib
import json
import logging
import subprocess
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional

try:
    from agent.memory_provider import MemoryProvider, is_trivial_prompt
    from agent.secret_scope import get_secret
except ImportError:  # unit tests run without the Hermes tree
    import os

    class MemoryProvider:  # type: ignore[no-redef]
        def on_session_end(self, messages: List[Dict[str, Any]]) -> None:
            return None

    def is_trivial_prompt(text: Optional[str]) -> bool:  # type: ignore[misc]
        return not (text or "").strip() or (text or "").strip().startswith("/")

    def get_secret(name: str, default: Optional[str] = None) -> Optional[str]:  # type: ignore[misc]
        return os.environ.get(name, default)

logger = logging.getLogger(__name__)

DEFAULT_URL = "http://127.0.0.1:8787/mcp/memory"
SKILL_INDEX_BUDGET = 6000
TIMEOUT = 5.0
PREFETCH_TIMEOUT = 1.5
PREFETCH_HITS = 5
PREFETCH_CHARS = 800

# How to use memory lives in the tool descriptions; the prompt only says what this block is.
HEADER = "长期记忆（当前房间：{scope}；只是参考，不扩大授权）："

TOOLS: List[Dict[str, Any]] = [
    {"name": "memory_search", "description": "Search memory facts. scope: current (default), _global, a scope slug, a comma list, or all.",
     "parameters": {"type": "object", "properties": {"query": {"type": "string"}, "scope": {"type": "string"},
                                                     "limit": {"type": "integer"}}, "required": ["query"]}},
    {"name": "memory_get", "description": "Read one fact (topic + kind) with optional history or as_of date.",
     "parameters": {"type": "object", "properties": {"topic": {"type": "string"}, "kind": {"type": "string"},
                                                     "scope": {"type": "string"}, "history": {"type": "boolean"},
                                                     "as_of": {"type": "string"}}, "required": ["topic", "kind"]}},
    {"name": "memory_load", "description": "Load a scope into this conversation like a skill: a role card (card-<name>) returns its persona and memory; any room returns its core memory. Tell the user you did.",
     "parameters": {"type": "object", "properties": {"scope": {"type": "string"}}, "required": ["scope"]}},
    {"name": "memory_scope", "description": "Show the current memory scope and list the discoverable scopes.",
     "parameters": {"type": "object", "properties": {}}},
]
WRITE_TOOLS: List[Dict[str, Any]] = [
    {"name": "memory_write", "description": (
        "Record a durable fact the user confirmed (decision, preference, rule, lesson); never credentials or one-off "
        "state. topic: lowercase ASCII slug (give topic_display in Chinese); kind: preference, rule, "
        "decision, fact, lesson, pointer or profile. value is one line; details in body. Same topic+kind supersedes "
        "the old value. scope defaults to the current room (in a DM: the assistants' shared scope); use _global only "
        "for the user's profile, preferences and rules that every agent, coding agents included, should know."),
     "parameters": {"type": "object", "properties": {
         "topic": {"type": "string"}, "kind": {"type": "string"}, "value": {"type": "string"},
         "topic_display": {"type": "string"}, "aliases": {"type": "array", "items": {"type": "string"}},
         "body": {"type": "string"}, "pin": {"type": "boolean"}, "scope": {"type": "string"}},
         "required": ["topic", "kind", "value"]}},
    {"name": "memory_retract", "description": "Retract a wrong or outdated fact (kept in history).",
     "parameters": {"type": "object", "properties": {"topic": {"type": "string"}, "kind": {"type": "string"},
                                                     "reason": {"type": "string"}, "scope": {"type": "string"}},
                    "required": ["topic", "kind", "reason"]}},
]
# Hermes tool name -> /mcp/memory tool name.
FORWARDED = {"memory_search": "search", "memory_get": "get", "memory_load": "load", "memory_write": "write",
             "memory_retract": "retract"}


class MemoryUnavailable(RuntimeError):
    pass


def room_key(chat_id: str) -> str:
    index = chat_id.find(":$")
    return chat_id[:index] if index >= 0 else chat_id


def _content_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(part.get("text", "") for part in content if isinstance(part, dict))
    return ""


def _decode(text: str, content_type: str) -> Dict[str, Any]:
    """A Streamable HTTP reply is one SSE `data:` event; the legacy /mcp answers plain JSON."""
    if "text/event-stream" in content_type:
        text = next((line[5:].strip() for line in text.splitlines() if line.startswith("data:")), "{}")
    return json.loads(text)


def _one_line(text: str, limit: int) -> str:
    flat = " ".join(text.split())
    return flat if len(flat) <= limit else flat[: limit - 1] + "…"


class AgentBridgeMemoryProvider(MemoryProvider):
    def __init__(self) -> None:
        self._url = DEFAULT_URL
        self._token = ""
        self._self_scope = ""
        self._shared_scope = ""
        self._skill_scopes = ""
        self._scope = "_global"
        # Hermes reads tool schemas before initialize(); start writable and narrow for cron/subagents.
        self._writable = True
        self._block = ""
        self._cache_dir: Optional[Path] = None
        self._cache_key = "default"
        self._request_id = 0
        self._prefetch = False

    @property
    def name(self) -> str:
        return "agent-bridge-memory"

    # ---- configuration ----

    def _load_config(self) -> None:
        self._url = get_secret("AGENT_MEMORY_URL", "") or DEFAULT_URL
        self._token = get_secret("AGENT_TOKEN", "") or get_secret("AGENT_MEMORY_TOKEN", "") or ""
        self._self_scope = get_secret("AGENT_MEMORY_SELF_SCOPE", "") or ""
        self._shared_scope = get_secret("AGENT_MEMORY_SHARED_SCOPE", "") or ""
        self._machine_id = get_secret("AGENT_MEMORY_MACHINE_ID", "") or "hal"
        self._skill_scopes = (get_secret("AGENT_SKILLS_SCOPES", "") or "").strip()

    def is_available(self) -> bool:
        self._load_config()
        return bool(self._token)

    def unavailable_reason(self) -> str:
        return "set AGENT_TOKEN (this agent's token from the Control Plane AGENT_TOKENS) in this profile's .env"

    # ---- MCP transport ----

    def _call(self, tool: str, arguments: Dict[str, Any], timeout: float = TIMEOUT) -> Dict[str, Any]:
        self._request_id += 1
        body = json.dumps({"jsonrpc": "2.0", "id": self._request_id, "method": "tools/call",
                           "params": {"name": tool, "arguments": arguments}}).encode("utf-8")
        request = urllib.request.Request(self._url, data=body, method="POST", headers={
            "Authorization": f"Bearer {self._token}", "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream"})
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                reply = _decode(response.read().decode("utf-8"), response.headers.get("Content-Type") or "")
        except Exception as exc:  # network, HTTP or JSON failure
            raise MemoryUnavailable(f"memory_unavailable: {exc}") from exc
        if "error" in reply:
            raise ValueError(reply["error"].get("message", "memory_error"))
        if reply["result"].get("isError"):
            raise ValueError(_content_text(reply["result"].get("content")) or "memory_error")
        return reply["result"]["structuredContent"]

    # ---- lifecycle ----

    def initialize(self, session_id: str, **kwargs) -> None:
        self._load_config()
        self._writable = kwargs.get("agent_context", "primary") == "primary"
        self._cache_dir = Path(kwargs.get("hermes_home") or ".") / "cache" / "agent-memory"
        locator: Dict[str, Any] = {}
        chat_id = str(kwargs.get("chat_id") or "")
        if chat_id and kwargs.get("platform") not in (None, "cli"):
            locator["room_id"] = room_key(chat_id)
            if kwargs.get("chat_name"):
                locator["room_name"] = str(kwargs["chat_name"])
        elif kwargs.get("cwd"):
            cwd = str(kwargs["cwd"])
            locator.update(machine_id=self._machine_id, cwd=cwd)
            remote = self._git_remote(cwd)
            if remote:
                locator["repository"] = remote
        # Keyed by room/cwd, not scope: an outage must still find this room's snapshot.
        key = locator.get("room_id") or locator.get("cwd") or "default"
        self._cache_key = hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]
        if "room_id" in locator and self._writable:
            locator["create"] = True  # a new room is a new direction; repo scopes wait for a first write
        try:
            resolved = self._call("scope", locator)
            self._scope = resolved.get("scope", "_global")
            self._prefetch = bool(resolved.get("prefetch"))
            if resolved.get("conflict"):
                logger.warning("agent-memory: scope binding conflict %s", resolved["conflict"])
            self._block = self._render(self._fetch_bootstrap(), resolved.get("warnings") or [])
            skills = self._skill_index()
            if skills:
                self._block = f"{self._block}\n\n{skills}"
            self._write_cache(self._block)
        except Exception as exc:
            logger.warning("agent-memory: using cached core memory (%s)", exc)
            self._block = self._read_cache()

    def _fetch_bootstrap(self) -> str:
        parts = [self._call("bootstrap", {"scope": self._scope})["text"]]
        for extra in dict.fromkeys(item for item in (self._shared_scope, self._self_scope) if item):
            try:
                # The self scope's persona is already SOUL.md (a symlink to its soul.md); only its memory here.
                parts.append(self._call("load", {"scope": extra, "include_persona": False})["text"])
            except ValueError as exc:
                logger.warning("agent-memory: scope %s unavailable: %s", extra, exc)
        return "\n".join(part for part in parts if part)

    def _home_scope(self) -> str:
        """Default scope for tool calls: the room, or in a DM the assistants' shared scope (not _global)."""
        return self._shared_scope if self._scope == "_global" and self._shared_scope else self._scope

    def _skill_index(self, budget: int = SKILL_INDEX_BUDGET) -> str:
        """Skill list from the shared library for scopes in AGENT_SKILLS_SCOPES: the room's skills and pinned skills
        (room, own scope, then _global); the rest are only counted."""
        pilot = {item.strip() for item in self._skill_scopes.split(",") if item.strip()}
        if not pilot or (self._skill_scopes != "all" and self._scope not in pilot):
            return ""
        scopes = list(dict.fromkeys(item for item in (self._scope, self._self_scope, self._shared_scope, "_global") if item))
        try:
            skills = self._call("skills", {"scopes": scopes})["skills"]
        except Exception as exc:
            logger.warning("agent-memory: skill list unavailable: %s", exc)
            return ""
        if not skills:
            return ""
        # Pinned skills are shown up front; the room's own skills are its specialty and count as pinned.
        # _global and _agent-* are never "the room" (a DM resolves to _global): only their pinned skills show.
        room = "" if self._scope.startswith("_") else self._scope
        listed = [item for item in skills if (room and item["scope"] == room) or item.get("pinned")]
        lines = ["## Skills (shared library)",
                 "Load a skill with skill_view(name) before doing a task it covers. "
                 "Save reusable procedures with skill_manage; new skills go to this room's scope."]
        used = sum(len(line) + 1 for line in lines)
        shown = 0
        for item in listed:
            line = f"- {item['name']}: {_one_line(item['description'], 200)}"
            if used + len(line) + 1 > budget:
                break
            lines.append(line)
            used += len(line) + 1
            shown += 1
        rest = len(skills) - shown
        if rest > 0:
            lines.append(f"- {rest} more skills are available: use skills_list to find them before starting a task")
        return "\n".join(lines)

    def _render(self, bootstrap: str, warnings: List[str]) -> str:
        note = "\n".join(f"- 注意：{warning}" for warning in warnings)
        return "\n".join(part for part in (HEADER.format(scope=self._scope), bootstrap, note) if part)

    def _cache_file(self) -> Optional[Path]:
        return self._cache_dir / f"{self._cache_key}.md" if self._cache_dir else None

    def _write_cache(self, text: str) -> None:
        path = self._cache_file()
        if not path:
            return
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".tmp")
            tmp.write_text(text, encoding="utf-8")
            tmp.replace(path)
        except OSError:
            pass

    def _read_cache(self) -> str:
        path = self._cache_file()
        if path and path.is_file():
            return path.read_text(encoding="utf-8") + "\n\n（记忆服务暂不可用：以上为缓存快照，写入会失败。）"
        return ""

    @staticmethod
    def _git_remote(cwd: str) -> str:
        try:
            return subprocess.run(["git", "-C", cwd, "config", "--get", "remote.origin.url"], capture_output=True,
                                  text=True, timeout=3).stdout.strip()
        except Exception:
            return ""

    def system_prompt_block(self) -> str:
        return self._block

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        """Per-turn recall for scopes with `prefetch: true`: memory relevant to this message that the
        fixed core block does not already contain. Fast local search; empty on any failure."""
        if not self._prefetch or is_trivial_prompt(query):
            return ""
        try:
            scopes = ",".join(dict.fromkeys(item for item in (self._scope, self._shared_scope, "_global") if item))
            hits = self._call("search", {"query": query[:500], "scope": scopes, "mode": "recall",
                                                "limit": PREFETCH_HITS}, timeout=PREFETCH_TIMEOUT).get("hits", [])
        except Exception:
            return ""
        lines: List[str] = []
        for hit in hits:
            text = str(hit.get("text", ""))
            value = text.split(" = ", 1)[-1]
            if value and value in self._block:
                continue
            lines.append(f"- [{hit.get('scope')}] {text}")
        if not lines:
            return ""
        out = f"与这条消息相关、开局记忆里没有的内容（作用域 {self._scope}）：\n" + "\n".join(lines)
        return out[:PREFETCH_CHARS]

    def on_session_switch(self, new_session_id: str, *, parent_session_id: str = "", reset: bool = False,
                          rewound: bool = False, **kwargs) -> None:
        # Same room, so same scope; the system block stays byte-stable for this agent instance.
        return None

    # ---- tools ----

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        # Always listed (schemas are read before initialize); handle_tool_call enforces read-only contexts.
        return TOOLS + WRITE_TOOLS

    def handle_tool_call(self, tool_name: str, args: Dict[str, Any], **kwargs) -> str:
        try:
            if tool_name == "memory_scope":
                listed = self._call("scopes", {})
                return json.dumps({"current_scope": self._scope, **listed}, ensure_ascii=False)
            if tool_name not in FORWARDED:
                return json.dumps({"error": f"unknown tool {tool_name}"})
            if tool_name in {"memory_write", "memory_retract"} and not self._writable:
                return json.dumps({"error": "read_only_context"})
            arguments = {key: value for key, value in (args or {}).items() if value is not None}
            scope = arguments.get("scope")
            if tool_name != "memory_load" and (not scope or scope == "current"):
                home = self._home_scope()
                # A DM searches its shared scope and _global together; the room's own scope otherwise.
                arguments["scope"] = f"{home},_global" if tool_name == "memory_search" and home != self._scope else home
            return json.dumps(self._call(FORWARDED[tool_name], arguments), ensure_ascii=False)
        except Exception as exc:
            return json.dumps({"error": str(exc)}, ensure_ascii=False)


def register(ctx) -> None:
    ctx.register_memory_provider(AgentBridgeMemoryProvider())
