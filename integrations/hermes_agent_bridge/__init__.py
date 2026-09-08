"""Hermes plugin that turns Agent Bridge endpoints into Kanban worker lanes."""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
import subprocess
import sys
import threading
from typing import Any

from .approval_relay import ApprovalRelay
from .worker_api import WorkerApi, WorkerApiError

logger = logging.getLogger(__name__)

_TOKEN_ENV = "AGENT_BRIDGE_WORKER_API_TOKEN"
_children: dict[str, subprocess.Popen] = {}
_relays: dict[str, ApprovalRelay] = {}


def _settings(ctx) -> dict[str, Any]:
    return {
        "api_url": str(ctx.get_config("api_url", "http://127.0.0.1:8787")).rstrip("/"),
        "worker_prefix": str(ctx.get_config("worker_prefix", "codex@")).lower(),
        "poll_interval": max(1.0, float(ctx.get_config("poll_interval_seconds", 3))),
        "heartbeat_interval": max(5.0, float(ctx.get_config("heartbeat_interval_seconds", 30))),
        "claim_ttl": max(60, int(ctx.get_config("claim_ttl_seconds", 900))),
        "failure_timeout": max(30.0, float(ctx.get_config("api_failure_timeout_seconds", 300))),
        "completion_mode": str(ctx.get_config("completion_mode", "done")).lower(),
        "reviewer": ctx.get_config("reviewer"),
        "max_in_progress": max(1, int(ctx.get_config("max_in_progress", 4))),
    }


def _prune_children() -> None:
    for task_id, child in list(_children.items()):
        if child.poll() is not None:
            _children.pop(task_id, None)


def _matches_lane(task_id: str, board: str, worker_prefix: str) -> bool:
    try:
        from hermes_cli.kanban_db import get_task
        from hermes_cli.kanban_db_connect import connect_closing

        with connect_closing(board=board) as conn:
            task = get_task(conn, task_id)
        return bool(task and task.assignee and task.assignee.lower().startswith(worker_prefix))
    except Exception as exc:
        logger.warning("agent-bridge could not inspect Kanban task %s: %s", task_id, exc)
        return False


def _spawn_supervisor(task_id: str, board: str, settings: dict[str, Any]) -> None:
    supervisor = Path(__file__).with_name("supervisor.py")
    args = [
        sys.executable,
        str(supervisor),
        "--task-id", task_id,
        "--board", board,
        "--api-url", settings["api_url"],
        "--poll-interval", str(settings["poll_interval"]),
        "--heartbeat-interval", str(settings["heartbeat_interval"]),
        "--claim-ttl", str(settings["claim_ttl"]),
        "--api-failure-timeout", str(settings["failure_timeout"]),
        "--completion-mode", settings["completion_mode"],
        "--worker-prefix", settings["worker_prefix"],
    ]
    if settings.get("reviewer"):
        args.extend(("--reviewer", str(settings["reviewer"])))
    child = subprocess.Popen(args, close_fds=True, start_new_session=True)
    _children[task_id] = child
    logger.info("agent-bridge supervisor started for %s on board %s (pid=%s)", task_id, board, child.pid)


def _dispatch_tick(settings: dict[str, Any], **payload) -> None:
    if payload.get("dry_run"):
        return
    board = payload.get("board")
    result = payload.get("result")
    if not isinstance(board, str) or not board or result is None:
        return
    token = os.environ.get(_TOKEN_ENV)
    if not token:
        logger.warning("agent-bridge plugin is enabled but %s is not set", _TOKEN_ENV)
        return
    _prune_children()
    capacity = settings["max_in_progress"] - len(_children)
    if capacity <= 0:
        return
    candidates = list(getattr(result, "skipped_nonspawnable", ()) or ())
    for task_id in candidates:
        if capacity <= 0:
            break
        task_id = str(task_id)
        if task_id in _children or not _matches_lane(task_id, board, settings["worker_prefix"]):
            continue
        _spawn_supervisor(task_id, board, settings)
        capacity -= 1


def _workers_tool(settings: dict[str, Any], _args: dict[str, Any], **_kwargs) -> str:
    token = os.environ.get(_TOKEN_ENV)
    if not token:
        return json.dumps({"success": False, "error": f"{_TOKEN_ENV} is not set"})
    try:
        workers = WorkerApi(settings["api_url"], token).workers()
    except WorkerApiError as exc:
        return json.dumps({"success": False, "error": str(exc)})
    return json.dumps({"success": True, "workers": workers}, ensure_ascii=False)


def _sessions_tool(settings: dict[str, Any], args: dict[str, Any], **_kwargs) -> str:
    token = os.environ.get(_TOKEN_ENV)
    if not token:
        return json.dumps({"success": False, "error": f"{_TOKEN_ENV} is not set"})
    try:
        page = WorkerApi(settings["api_url"], token).sessions(
            worker_id=args.get("workerId"),
            workspace=args.get("workspace"),
            q=args.get("q"),
            task_id=args.get("taskId"),
            active=args.get("active"),
            limit=args.get("limit"),
        )
    except WorkerApiError as exc:
        return json.dumps({"success": False, "error": str(exc)})
    return json.dumps({"success": True, **page}, ensure_ascii=False)


def _session_context_tool(settings: dict[str, Any], args: dict[str, Any], **_kwargs) -> str:
    token = os.environ.get(_TOKEN_ENV)
    if not token:
        return json.dumps({"success": False, "error": f"{_TOKEN_ENV} is not set"})
    try:
        context = WorkerApi(settings["api_url"], token).session_context(args["sessionId"])
    except WorkerApiError as exc:
        return json.dumps({"success": False, "error": str(exc)})
    return json.dumps({"success": True, **context}, ensure_ascii=False)


_WORKERS_SCHEMA = {
    "name": "agent_bridge_workers",
    "description": (
        "List Agent Bridge workers and their recently used workspaces. Use this before assigning "
        "a Hermes Kanban task to a non-profile lane such as codex@machine."
    ),
    "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
}

_SESSIONS_SCHEMA = {
    "name": "agent_bridge_sessions",
    "description": (
        "Read Agent Bridge sessions so a user can select an existing Codex session to resume. "
        "Filters are optional and do not modify session state."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "workerId": {"type": "string", "description": "Worker ID such as codex@machine."},
            "workspace": {"type": "string", "description": "Exact remote workspace path."},
            "q": {"type": "string", "description": "Free-text session search."},
            "taskId": {"type": "string", "description": "Exact task ID."},
            "active": {"type": "boolean", "description": "Filter active or inactive sessions."},
            "limit": {"type": "integer", "minimum": 1, "maximum": 200},
        },
        "additionalProperties": False,
    },
}

_SESSION_CONTEXT_SCHEMA = {
    "name": "agent_bridge_session_context",
    "description": "Read one Agent Bridge session and the tail of its events without changing state.",
    "parameters": {
        "type": "object",
        "properties": {
            "sessionId": {"type": "string", "minLength": 1, "description": "Control Plane session ID."},
        },
        "required": ["sessionId"],
        "additionalProperties": False,
    },
}


def register(ctx) -> None:
    settings = _settings(ctx)
    if settings["completion_mode"] not in {"done", "review"}:
        raise ValueError("agent-bridge-worker completion_mode must be 'done' or 'review'")
    token = os.environ.get(_TOKEN_ENV)
    profile_name = ctx.profile_name
    if token and profile_name not in _relays:
        relay = ApprovalRelay(
            api=WorkerApi(settings["api_url"], token),
            profile_name=profile_name,
            worker_prefix=settings["worker_prefix"],
            poll_interval=settings["poll_interval"],
        )
        _relays[profile_name] = relay
        threading.Thread(
            target=relay.run,
            name=f"agent-bridge-approval-relay-{profile_name}",
            daemon=True,
        ).start()

        def _stop_relay() -> None:
            relay.stop()
            _relays.pop(profile_name, None)

        ctx.on_unload(_stop_relay)
    ctx.register_hook("on_kanban_dispatch_tick", lambda **kw: _dispatch_tick(settings, **kw))
    ctx.register_tool(
        name="agent_bridge_workers",
        toolset="agent_bridge",
        schema=_WORKERS_SCHEMA,
        handler=lambda args, **kw: _workers_tool(settings, args, **kw),
        check_fn=lambda: bool(os.environ.get(_TOKEN_ENV)),
        requires_env=[_TOKEN_ENV],
        description="List remote Codex workers exposed by Agent Bridge.",
        emoji="🌉",
    )
    ctx.register_tool(
        name="agent_bridge_sessions",
        toolset="agent_bridge",
        schema=_SESSIONS_SCHEMA,
        handler=lambda args, **kw: _sessions_tool(settings, args, **kw),
        check_fn=lambda: bool(os.environ.get(_TOKEN_ENV)),
        requires_env=[_TOKEN_ENV],
        description="Search remote Codex sessions exposed by Agent Bridge.",
        emoji="🔎",
    )
    ctx.register_tool(
        name="agent_bridge_session_context",
        toolset="agent_bridge",
        schema=_SESSION_CONTEXT_SCHEMA,
        handler=lambda args, **kw: _session_context_tool(settings, args, **kw),
        check_fn=lambda: bool(os.environ.get(_TOKEN_ENV)),
        requires_env=[_TOKEN_ENV],
        description="Read one remote Codex session and its recent events.",
        emoji="🧵",
    )
