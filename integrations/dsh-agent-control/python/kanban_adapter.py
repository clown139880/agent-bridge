#!/usr/bin/env python3
"""Structured local adapter for Hermes Kanban.

This process exposes a small JSON-lines allowlist and imports the real Hermes
domain layer. It never invokes ``hermes kanban`` and intentionally contains no
claim/heartbeat/complete/block/delete/archive operations.
"""
from __future__ import annotations

import argparse
import json
import sys
from contextlib import closing
from dataclasses import asdict, is_dataclass
from pathlib import Path
from typing import Any


def _jsonable(value: Any) -> Any:
    if is_dataclass(value):
        return {key: _jsonable(item) for key, item in asdict(value).items()}
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(item) for item in value]
    if isinstance(value, Path):
        return str(value)
    return value


def _required(args: dict[str, Any], key: str) -> Any:
    value = args.get(key)
    if value is None or (isinstance(value, str) and not value.strip()):
        raise ValueError(f"{key} is required")
    return value


def _create_kwargs(args: dict[str, Any]) -> dict[str, Any]:
    mapping = {
        "title": "title", "body": "body", "assignee": "assignee", "tenant": "tenant",
        "priority": "priority", "workspaceKind": "workspace_kind", "workspacePath": "workspace_path",
        "parents": "parents", "triage": "triage", "idempotencyKey": "idempotency_key",
        "maxRuntimeSeconds": "max_runtime_seconds", "skills": "skills", "goalMode": "goal_mode",
        "goalMaxTurns": "goal_max_turns", "modelOverride": "model_override",
        "providerOverride": "provider_override", "reasoningEffort": "reasoning_effort",
        "projectId": "project_id",
    }
    return {target: args[source] for source, target in mapping.items() if source in args}


def dispatch(kb: Any, kbc: Any, request: dict[str, Any]) -> Any:
    operation = request.get("operation")
    args = request.get("args") or {}
    if not isinstance(args, dict):
        raise ValueError("args must be an object")
    board = request.get("board") or "default"
    author = request.get("author") or "dsh-orchestrator"
    kb.init_db(board=board)
    with closing(kbc.connect(board=board)) as conn:
        if operation == "list":
            tasks = kb.list_tasks(conn, include_archived=False)
            columns = {name: [] for name in ("triage", "todo", "scheduled", "ready", "running", "blocked", "review", "done")}
            summaries = kb.latest_summaries(conn, [task.id for task in tasks])
            for task in tasks:
                item = _jsonable(task)
                item["latest_summary"] = summaries.get(task.id)
                columns.setdefault(task.status, []).append(item)
            latest = conn.execute("SELECT COALESCE(MAX(id), 0) AS n FROM task_events").fetchone()["n"]
            return {"columns": [{"name": name, "tasks": items} for name, items in columns.items()],
                    "assignees": [item["name"] for item in kb.known_assignees(conn)],
                    "latest_event_id": int(latest)}
        if operation == "show":
            task_id = str(_required(args, "taskId"))
            task = kb.get_task(conn, task_id)
            if task is None:
                raise ValueError(f"task {task_id} not found")
            parents = [row["parent_id"] for row in conn.execute("SELECT parent_id FROM task_links WHERE child_id = ? ORDER BY parent_id", (task_id,))]
            children = [row["child_id"] for row in conn.execute("SELECT child_id FROM task_links WHERE parent_id = ? ORDER BY child_id", (task_id,))]
            return {"task": _jsonable(task), "comments": _jsonable(kb.list_comments(conn, task_id)),
                    "events": _jsonable(kb.list_events(conn, task_id)), "links": {"parents": parents, "children": children},
                    "runs": _jsonable(kb.list_runs(conn, task_id)), "latest_summary": kb.latest_summary(conn, task_id)}
        if operation == "assignees":
            return {"assignees": _jsonable(kb.known_assignees(conn))}
        if operation == "create":
            kwargs = _create_kwargs(args)
            _required(kwargs, "title")
            task_id = kb.create_task(conn, created_by=author, board=board, **kwargs)
            return {"task": _jsonable(kb.get_task(conn, task_id))}
        if operation == "comment":
            task_id, body = str(_required(args, "taskId")), str(_required(args, "body"))
            return {"ok": True, "taskId": task_id, "commentId": kb.add_comment(conn, task_id, author=author, body=body)}
        if operation == "link":
            parent, child = str(_required(args, "parentId")), str(_required(args, "childId"))
            kb.link_tasks(conn, parent, child)
            return {"ok": True, "parentId": parent, "childId": child}
        if operation == "request_review":
            task_id = str(_required(args, "taskId"))
            ok, reason = kb.request_review(conn, task_id, summary=str(_required(args, "summary")),
                                           reviewer=args.get("reviewer"), force=bool(args.get("force", False)), with_reason=True)
            if not ok:
                raise ValueError(reason or "review request refused")
            return {"ok": True, "taskId": task_id}
        if operation == "request_changes":
            task_id = str(_required(args, "taskId"))
            expected = args.get("expectedRunId")
            ok, result = kb.request_changes(conn, task_id, reason=str(_required(args, "reason")),
                                             expected_run_id=int(expected) if expected is not None else None)
            if not ok:
                raise ValueError(result or "request changes refused")
            return {"ok": True, "taskId": task_id, "assignee": result}
        if operation == "unblock":
            task_id = str(_required(args, "taskId"))
            if not kb.unblock_task(conn, task_id):
                raise ValueError("unblock refused by Hermes task state")
            return {"ok": True, "taskId": task_id}
        if operation == "reassign":
            task_id = str(_required(args, "taskId"))
            if not kb.reassign_task(conn, task_id, args.get("assignee"), reclaim_first=False, reason=args.get("reason")):
                raise ValueError("reassign refused; running tasks must be reclaimed explicitly first")
            return {"ok": True, "taskId": task_id, "assignee": args.get("assignee")}
        if operation == "reclaim":
            task_id = str(_required(args, "taskId"))
            if not kb.reclaim_task(conn, task_id, reason=args.get("reason")):
                raise ValueError("reclaim refused by Hermes task state")
            return {"ok": True, "taskId": task_id}
        raise ValueError(f"unsupported operation: {operation}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--hermes-root", required=True)
    options = parser.parse_args()
    sys.path.insert(0, str(Path(options.hermes_root).resolve()))
    from hermes_cli import kanban_db as kb
    from hermes_cli import kanban_db_connect as kbc
    for line in sys.stdin:
        request_id: Any = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            response = {"id": request_id, "ok": True, "data": _jsonable(dispatch(kb, kbc, request))}
        except Exception as exc:
            response = {"id": request_id, "ok": False, "error": {"code": "kanban_refused", "message": str(exc)}}
        print(json.dumps(response, ensure_ascii=False, separators=(",", ":")), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
