"""Hermes plugin: skills_list / skill_view / skill_manage backed by the Agent Bridge skill library.

Skills live in one Git repository organised by agent-memory scope (design:
docs/agent-skills-design.zh.md). This plugin replaces the three built-in skill tools
and forwards them to the Control Plane `skill_*` MCP tools, so every write is a reviewed
commit in the right scope. The session's scope comes from its Matrix room (read from the
profile's state.db) resolved through `memory_resolve_scope`.

While piloting, only sessions whose scope is listed in AGENT_SKILLS_SCOPES use the
library; every other session falls through to the original Hermes handlers.

Configuration (profile .env):
  AGENT_MEMORY_TOKEN       writer token (shared with the memory provider; required)
  AGENT_MEMORY_URL         default http://127.0.0.1:8787/mcp
  AGENT_MEMORY_SELF_SCOPE  this agent's own scope, e.g. _agent-dorothy (always visible)
  AGENT_SKILLS_SCOPES      comma-separated pilot scopes, or "all"; unset/empty disables routing
  AGENT_SKILLS_LOAD_ALL    "true" lets skill_view/skill_manage reach every scope (Hermes)
Config: plugins.entries.agent-bridge-skills.allow_tool_override: true
"""
from __future__ import annotations

import json
import logging
import sqlite3
import threading
import urllib.request
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

try:
    from agent.secret_scope import get_secret
except ImportError:  # unit tests run without the Hermes tree
    import os

    def get_secret(name: str, default: Optional[str] = None) -> Optional[str]:  # type: ignore[misc]
        return os.environ.get(name, default)

logger = logging.getLogger(__name__)

DEFAULT_URL = "http://127.0.0.1:8787/mcp"
TIMEOUT = 10.0
GLOBAL = "_global"
TOOLS = ("skills_list", "skill_view", "skill_manage")


class Unavailable(RuntimeError):
    pass


def _ok(**fields: Any) -> str:
    return json.dumps({"success": True, **fields}, ensure_ascii=False)


def _fail(error: str, **fields: Any) -> str:
    return json.dumps({"success": False, "error": error, **fields}, ensure_ascii=False)


def room_key(chat_id: str) -> str:
    index = chat_id.find(":$")
    return chat_id[:index] if index >= 0 else chat_id


class SkillLibrary:
    """Per-profile router: session -> scope -> Control Plane skill tools."""

    def __init__(self, hermes_home: Path, originals: Dict[str, Callable[..., Any]],
                 call: Optional[Callable[[str, Dict[str, Any]], Dict[str, Any]]] = None) -> None:
        self.hermes_home = hermes_home
        self.originals = originals
        self.url = get_secret("AGENT_MEMORY_URL", "") or DEFAULT_URL
        self.token = get_secret("AGENT_MEMORY_TOKEN", "") or ""
        self.self_scope = get_secret("AGENT_MEMORY_SELF_SCOPE", "") or ""
        raw = (get_secret("AGENT_SKILLS_SCOPES", "") or "").strip()
        self.pilot: Optional[set] = None if raw == "all" else {item.strip() for item in raw.split(",") if item.strip()}
        self.load_all = (get_secret("AGENT_SKILLS_LOAD_ALL", "") or "").lower() == "true"
        self._call_impl = call or self._http_call
        self._scopes: Dict[str, str] = {}
        self._lock = threading.Lock()
        self._request_id = 0

    # ---- transport ----

    def _http_call(self, tool: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
        self._request_id += 1
        body = json.dumps({"jsonrpc": "2.0", "id": self._request_id, "method": "tools/call",
                           "params": {"name": tool, "arguments": arguments}}).encode("utf-8")
        request = urllib.request.Request(self.url, data=body, method="POST", headers={
            "Authorization": f"Bearer {self.token}", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
                reply = json.loads(response.read().decode("utf-8"))
        except Exception as exc:
            raise Unavailable(f"skill library unavailable: {exc}") from exc
        if "error" in reply:
            raise ValueError(reply["error"].get("message", "skill_error"))
        return reply["result"]["structuredContent"]

    def call(self, tool: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
        return self._call_impl(tool, arguments)

    # ---- scope ----

    def enabled(self) -> bool:
        return bool(self.token) and (self.pilot is None or bool(self.pilot))

    def _chat_id(self, session_id: str) -> str:
        db = self.hermes_home / "state.db"
        if not session_id or not db.exists():
            return ""
        try:
            with sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=2) as con:
                row = con.execute("select chat_id, source from sessions where id = ?", (session_id,)).fetchone()
        except sqlite3.Error as exc:
            logger.warning("agent-skills: cannot read session %s: %s", session_id, exc)
            return ""
        if not row or not row[0] or row[1] in ("cli", "cron"):
            return ""
        return str(row[0])

    def scope_for(self, session_id: str) -> str:
        with self._lock:
            cached = self._scopes.get(session_id)
        if cached:
            return cached
        chat_id = self._chat_id(session_id)
        scope = GLOBAL
        if chat_id:
            try:
                scope = self.call("memory_resolve_scope", {"room_id": room_key(chat_id)}).get("scope", GLOBAL)
            except Exception as exc:
                logger.warning("agent-skills: scope lookup failed for %s: %s", session_id, exc)
                return GLOBAL  # do not cache a failure
        with self._lock:
            self._scopes[session_id] = scope
        return scope

    def routed(self, scope: str) -> bool:
        return self.enabled() and (self.pilot is None or scope in self.pilot)

    def visible(self, scope: str) -> List[str]:
        """List order: the room, the agent's own scope, then _global (cut first when the list is long)."""
        result: List[str] = []
        for item in (scope, self.self_scope, GLOBAL):
            if item and item not in result:
                result.append(item)
        return result

    def reach(self, scope: str) -> Any:
        return "all" if self.load_all else self.visible(scope)

    # ---- tools ----

    def skills_list(self, args: Dict[str, Any], scope: str) -> str:
        skills = self.call("skill_index", {"scopes": self.visible(scope)})["skills"]
        category = args.get("category")
        if category:
            skills = [item for item in skills if item["category"] == category or item["category"].startswith(f"{category}/")]
        return _ok(skills=[{"name": item["name"], "description": item["description"], "category": item["category"],
                            "scope": item["scope"]} for item in skills],
                   categories=sorted({item["category"] for item in skills}), count=len(skills),
                   hint="Use skill_view(name) to see full content and linked files")

    def skill_view(self, args: Dict[str, Any], scope: str) -> Optional[str]:
        """None when the skill is not in the library (the caller falls back to local skills)."""
        name = str(args.get("name") or "")
        file_path = args.get("file_path") or "SKILL.md"
        try:
            view = self.call("skill_view", {"name": name, "scopes": self.reach(scope), "file": file_path})
        except ValueError as exc:
            message = str(exc)
            if "unknown_skill" in message:
                return None
            if "unknown_file" in message or "invalid_file_path" in message:
                files = self.call("skill_view", {"name": name, "scopes": self.reach(scope)})["files"]
                return _fail(f"File '{file_path}' not found in skill '{name}'.", available_files=files,
                             hint="Use one of the available file paths listed above")
            return _fail(message)
        linked = [item for item in view["files"] if item != "SKILL.md"]
        return _ok(name=view["name"], description=view["description"], scope=view["scope"], content=view["content"],
                   path=f"{view['path']}/{view['file']}", skill_dir=view["dir"], linked_files=linked,
                   usage_hint="To view linked files, call skill_view(name, file_path) where file_path is one of linked_files."
                   if linked else "")

    def skill_manage(self, args: Dict[str, Any], scope: str) -> Optional[str]:
        """Apply the operations in order; None when they target a skill outside the library."""
        operations = args.get("operations")
        if operations is None:  # legacy flat single-op shape
            operations = [{key: value for key, value in args.items() if key != "operations"}]
        if not isinstance(operations, list) or not operations:
            return _fail("operations must be a non-empty array")
        known = {item["name"] for item in self.call("skill_index", {"scopes": self.visible(scope)})["skills"]}
        reach = self.reach(scope)
        if self.load_all:
            known |= {item["name"] for item in self.call("skill_search", {"query": " ".join(
                str(op.get("name", "")) for op in operations), "scopes": "all", "limit": 50})["hits"]}
        if all(op.get("action") != "create" and op.get("name") not in known for op in operations):
            return None
        results = []
        for index, op in enumerate(operations):
            action, name = op.get("action"), str(op.get("name") or "")
            try:
                if action == "create":
                    result = self.call("skill_write", {"scope": scope, "name": name, "content": op.get("content", ""),
                                                       **({"category": op["category"]} if op.get("category") else {})})
                elif action == "patch" and "old_string" in op:
                    result = self.call("skill_patch", {"name": name, "scopes": reach, "file": op.get("file_path") or "SKILL.md",
                                                       "old_text": op["old_string"], "new_text": op.get("new_string", ""),
                                                       "replace_all": bool(op.get("replace_all"))})
                elif action in ("patch", "edit") and "content" in op:
                    result = self.call("skill_write", {"scope": self._scope_of(name, reach), "name": name, "content": op["content"]})
                elif action == "write_file":
                    result = self.call("skill_write", {"scope": self._scope_of(name, reach), "name": name,
                                                       "file": op.get("file_path", ""), "content": op.get("file_content", "")})
                elif action == "remove_file":
                    result = self.call("skill_remove_file", {"name": name, "scopes": reach, "file": op.get("file_path", "")})
                elif action == "delete":
                    reason = f"absorbed into {op['absorbed_into']}" if op.get("absorbed_into") else "deleted via skill_manage"
                    result = self.call("skill_archive", {"name": name, "scopes": reach, "reason": reason})
                else:
                    return _fail(f"operation {index}: unsupported action {action!r}", completed=results)
            except ValueError as exc:
                return _fail(f"operation {index} ({action} {name}): {exc}", completed=results)
            results.append({"action": action, "name": result.get("name", name), "scope": result.get("scope"),
                            "path": result.get("path"), "commit": result.get("commit")})
        return _ok(message=f"{len(results)} operation(s) applied to the skill library", results=results)

    def _scope_of(self, name: str, reach: Any) -> str:
        return self.call("skill_view", {"name": name, "scopes": reach})["scope"]


def _wrap(tool: str, lib: SkillLibrary, original: Callable[..., Any]) -> Callable[..., Any]:
    def handler(args: Dict[str, Any], **kwargs: Any) -> Any:
        scope = lib.scope_for(str(kwargs.get("session_id") or ""))
        if not lib.routed(scope):
            return original(args, **kwargs)
        try:
            if tool == "skills_list":
                return lib.skills_list(args, scope)
            result = lib.skill_view(args, scope) if tool == "skill_view" else lib.skill_manage(args, scope)
        except Unavailable as exc:
            if tool == "skill_manage":
                return _fail(f"{exc}; skill changes are not saved while the library is down")
            logger.warning("agent-skills: %s falling back to local skills: %s", tool, exc)
            return original(args, **kwargs)
        return original(args, **kwargs) if result is None else result
    return handler


def register(ctx) -> None:
    """One router per profile: the gateway loads plugins once per profile home with that home bound."""
    from tools.registry import registry  # Hermes tree only
    from hermes_constants import get_hermes_home

    entries = {name: registry.get_entry(name) for name in TOOLS}
    if any(entry is None for entry in entries.values()):
        logger.warning("agent-skills: built-in skill tools missing; plugin inactive")
        return
    lib = SkillLibrary(Path(get_hermes_home()), {name: entry.handler for name, entry in entries.items()})
    if not lib.enabled():
        logger.info("agent-skills: no token or no AGENT_SKILLS_SCOPES; built-in skill tools unchanged")
        return
    for name, entry in entries.items():
        ctx.register_tool(name=name, toolset=entry.toolset, schema=entry.schema,
                          handler=_wrap(name, lib, entry.handler), override=True)
    logger.info("agent-skills: routing %s to the skill library for scopes %s", ", ".join(TOOLS),
                "all" if lib.pilot is None else sorted(lib.pilot))
