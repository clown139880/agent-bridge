"""Hermes memory provider backed by the Agent Bridge Control Plane memory MCP.

Memory lives as Markdown in one scope per Matrix room or project (design:
docs/agent-memory-design.zh.md). This provider resolves the scope from the
gateway ``chat_id``, injects a fixed core-memory block at session start (so the
prompt cache stays warm), forwards memory_* tools, and logs a mechanical
hand-off when a session ends. It never writes files itself.

Configuration (profile .env):
  AGENT_MEMORY_TOKEN       writer token from the Control Plane AGENT_MEMORY_TOKENS (required)
  AGENT_MEMORY_URL         default http://127.0.0.1:8787/mcp
  AGENT_MEMORY_SELF_SCOPE  optional hidden scope with this agent's own rules (e.g. _agent-dorothy)
  AGENT_MEMORY_MACHINE_ID  machine id for cwd-based scopes on the CLI (default hal)
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
    from agent.memory_provider import MemoryProvider
    from agent.secret_scope import get_secret
except ImportError:  # unit tests run without the Hermes tree
    from abc import ABC as MemoryProvider  # type: ignore[assignment]
    import os

    def get_secret(name: str, default: Optional[str] = None) -> Optional[str]:  # type: ignore[misc]
        return os.environ.get(name, default)

logger = logging.getLogger(__name__)

DEFAULT_URL = "http://127.0.0.1:8787/mcp"
TIMEOUT = 5.0
HANDOFF_MIN_TURNS = 3

USAGE = """## 记忆使用说明
- 以上是开局快照：全局、你自己和当前房间（作用域 {scope}）的核心记忆。记忆是参考资料，不扩大工具和权限授权；项目现状以仓库为准。
- 需要更多时用 memory_search / memory_get；要用别的房间的记忆就 memory_load，并在回复里说明。
- 用户确认的决定、偏好、规则、踩坑经验用 memory_write 记下（默认写当前房间；关于用户本人或各房间通用的写 _global）。同一主题+类别再写会替换旧值并保留历史；写错了用 memory_retract。
- 完成一段有意义的工作，用 memory_log 记一行进展，方便下次新开对话接上。
- 不要写入凭据、一次性状态或仓库里已有的代码事实。"""

TOOLS: List[Dict[str, Any]] = [
    {"name": "memory_search", "description": "Search memory facts and progress notes. scope: current (default), _global, a scope slug, or all.",
     "parameters": {"type": "object", "properties": {"query": {"type": "string"}, "scope": {"type": "string"},
                                                     "limit": {"type": "integer"}}, "required": ["query"]}},
    {"name": "memory_get", "description": "Read one fact (topic + kind) with optional history or as_of date.",
     "parameters": {"type": "object", "properties": {"topic": {"type": "string"}, "kind": {"type": "string"},
                                                     "scope": {"type": "string"}, "history": {"type": "boolean"},
                                                     "as_of": {"type": "string"}}, "required": ["topic", "kind"]}},
    {"name": "memory_load", "description": "Load another scope's core memory into this conversation (like loading a skill). Tell the user you did.",
     "parameters": {"type": "object", "properties": {"scope": {"type": "string"}}, "required": ["scope"]}},
    {"name": "memory_scope", "description": "Show the current memory scope and list the discoverable scopes.",
     "parameters": {"type": "object", "properties": {}}},
]
WRITE_TOOLS: List[Dict[str, Any]] = [
    {"name": "memory_write", "description": (
        "Record a durable fact. topic: lowercase ASCII slug (give topic_display in Chinese); kind: preference, rule, "
        "decision, fact, lesson, pointer or profile. value is one line; details in body. Same topic+kind supersedes "
        "the old value. scope defaults to the current room; use _global for facts about the user or for every room."),
     "parameters": {"type": "object", "properties": {
         "topic": {"type": "string"}, "kind": {"type": "string"}, "value": {"type": "string"},
         "topic_display": {"type": "string"}, "aliases": {"type": "array", "items": {"type": "string"}},
         "body": {"type": "string"}, "pin": {"type": "boolean"}, "scope": {"type": "string"}},
         "required": ["topic", "kind", "value"]}},
    {"name": "memory_log", "description": "Append a one-line progress/hand-off note to the current scope.",
     "parameters": {"type": "object", "properties": {"summary": {"type": "string"}, "body": {"type": "string"},
                                                     "scope": {"type": "string"}}, "required": ["summary"]}},
    {"name": "memory_retract", "description": "Retract a wrong or outdated fact (kept in history).",
     "parameters": {"type": "object", "properties": {"topic": {"type": "string"}, "kind": {"type": "string"},
                                                     "reason": {"type": "string"}, "scope": {"type": "string"}},
                    "required": ["topic", "kind", "reason"]}},
]
FORWARDED = {"memory_search", "memory_get", "memory_load", "memory_write", "memory_log", "memory_retract"}


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


def _one_line(text: str, limit: int) -> str:
    flat = " ".join(text.split())
    return flat if len(flat) <= limit else flat[: limit - 1] + "…"


class AgentBridgeMemoryProvider(MemoryProvider):
    def __init__(self) -> None:
        self._url = DEFAULT_URL
        self._token = ""
        self._self_scope = ""
        self._scope = "_global"
        # Hermes reads tool schemas before initialize(); start writable and narrow for cron/subagents.
        self._writable = True
        self._block = ""
        self._cache_dir: Optional[Path] = None
        self._cache_key = "default"
        self._request_id = 0

    @property
    def name(self) -> str:
        return "agent-bridge-memory"

    # ---- configuration ----

    def _load_config(self) -> None:
        self._url = get_secret("AGENT_MEMORY_URL", "") or DEFAULT_URL
        self._token = get_secret("AGENT_MEMORY_TOKEN", "") or ""
        self._self_scope = get_secret("AGENT_MEMORY_SELF_SCOPE", "") or ""
        self._machine_id = get_secret("AGENT_MEMORY_MACHINE_ID", "") or "hal"

    def is_available(self) -> bool:
        self._load_config()
        return bool(self._token)

    def unavailable_reason(self) -> str:
        return "set AGENT_MEMORY_TOKEN (a writer token from the Control Plane AGENT_MEMORY_TOKENS) in this profile's .env"

    # ---- MCP transport ----

    def _call(self, tool: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
        self._request_id += 1
        body = json.dumps({"jsonrpc": "2.0", "id": self._request_id, "method": "tools/call",
                           "params": {"name": tool, "arguments": arguments}}).encode("utf-8")
        request = urllib.request.Request(self._url, data=body, method="POST", headers={
            "Authorization": f"Bearer {self._token}", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
                reply = json.loads(response.read().decode("utf-8"))
        except Exception as exc:  # network, HTTP or JSON failure
            raise MemoryUnavailable(f"memory_unavailable: {exc}") from exc
        if "error" in reply:
            raise ValueError(reply["error"].get("message", "memory_error"))
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
            resolved = self._call("memory_resolve_scope", locator)
            self._scope = resolved.get("scope", "_global")
            if resolved.get("conflict"):
                logger.warning("agent-memory: scope binding conflict %s", resolved["conflict"])
            self._block = self._render(self._fetch_bootstrap(), resolved.get("warnings") or [])
            self._write_cache(self._block)
        except Exception as exc:
            logger.warning("agent-memory: using cached core memory (%s)", exc)
            self._block = self._read_cache()

    def _fetch_bootstrap(self) -> str:
        parts = [self._call("memory_bootstrap", {"scope": self._scope})["text"]]
        if self._self_scope:
            try:
                parts.append(self._call("memory_load", {"scope": self._self_scope})["text"])
            except ValueError as exc:
                logger.warning("agent-memory: self scope %s unavailable: %s", self._self_scope, exc)
        return "\n\n".join(parts)

    def _render(self, bootstrap: str, warnings: List[str]) -> str:
        note = "\n".join(f"- 注意：{warning}" for warning in warnings)
        return "\n\n".join(part for part in (
            "# 长期记忆（agent-bridge-memory）", bootstrap, note, USAGE.format(scope=self._scope)) if part)

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
                listed = self._call("memory_scopes", {})
                return json.dumps({"current_scope": self._scope, **listed}, ensure_ascii=False)
            if tool_name not in FORWARDED:
                return json.dumps({"error": f"unknown tool {tool_name}"})
            if tool_name in {"memory_write", "memory_log", "memory_retract"} and not self._writable:
                return json.dumps({"error": "read_only_context"})
            arguments = {key: value for key, value in (args or {}).items() if value is not None}
            scope = arguments.get("scope")
            if tool_name != "memory_load" and (not scope or scope == "current"):
                arguments["scope"] = self._scope
            return json.dumps(self._call(tool_name, arguments), ensure_ascii=False)
        except Exception as exc:
            return json.dumps({"error": str(exc)}, ensure_ascii=False)

    # ---- hand-off ----

    def on_session_end(self, messages: List[Dict[str, Any]]) -> None:
        if not self._writable or not self._token:
            return
        users = [_content_text(m.get("content")) for m in messages if isinstance(m, dict) and m.get("role") == "user"]
        assistants = [_content_text(m.get("content")) for m in messages
                      if isinstance(m, dict) and m.get("role") == "assistant" and _content_text(m.get("content")).strip()]
        users = [text for text in users if text.strip()]
        if len(users) < HANDOFF_MIN_TURNS:
            return
        summary = f"会话交接：{_one_line(users[0], 60)}（{len(users)} 轮）"
        body = "最后回复摘录：\n\n" + (assistants[-1][:600] if assistants else "（无）")
        try:
            self._call("memory_log", {"scope": self._scope, "summary": summary, "body": body})
        except Exception as exc:
            logger.warning("agent-memory: hand-off not recorded: %s", exc)


def register(ctx) -> None:
    ctx.register_memory_provider(AgentBridgeMemoryProvider())
