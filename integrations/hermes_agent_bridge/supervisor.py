"""One-process supervisor for one Hermes Kanban claim and one remote Codex run."""

from __future__ import annotations

import argparse
import logging
import ntpath
import os
from pathlib import Path
import re
import socket
import time
from typing import Any

try:
    from .worker_api import WorkerApi, WorkerApiError
except ImportError:  # Executed directly by the dispatcher plugin.
    from worker_api import WorkerApi, WorkerApiError

logger = logging.getLogger("hermes.agent_bridge_worker")
TOKEN_ENV = "AGENT_BRIDGE_WORKER_API_TOKEN"
TERMINAL_STATUSES = {"completed", "failed", "stopped"}
# Admission states are intentionally non-terminal: the claim stays alive and
# must never be interpreted as a successfully dispatched Codex run.
UPDATE_ADMISSION_STATUSES = {"update_waiting", "update_required", "update_failed"}
_RESUME_MARKER = "<!-- agent-bridge-worker"
_RESUME_DIRECTIVE = re.compile(
    r"<!-- agent-bridge-worker\r?\n"
    r"resume-session-id: ([^\s]+)\r?\n"
    r"-->",
)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("--task-id", required=True)
    parser.add_argument("--board", required=True)
    parser.add_argument("--api-url", required=True)
    parser.add_argument("--poll-interval", type=float, default=3)
    parser.add_argument("--heartbeat-interval", type=float, default=30)
    parser.add_argument("--claim-ttl", type=int, default=900)
    parser.add_argument("--api-failure-timeout", type=float, default=300)
    parser.add_argument("--stalled-blocked-timeout", type=float, default=300)
    parser.add_argument("--completion-mode", choices=("done", "review"), default="done")
    parser.add_argument("--reviewer")
    parser.add_argument("--worker-prefix", default="codex@")
    return parser


def _remote_workspace(task) -> str:
    if task.workspace_kind != "dir":
        raise ValueError(
            f"external worker requires workspace_kind=dir, got {task.workspace_kind!r}; "
            "set the absolute path as it appears on the selected bridge machine"
        )
    value = (task.workspace_path or "").strip()
    # The supervisor validates the path on HAL, but the path belongs to the
    # selected Bridge host.  POSIX Path.is_absolute() rejects Windows drive
    # paths (for example C:\\Users\\clown\\Workspace\\agent-bridge), which
    # caused Windows claims to be blocked locally before WorkerApi.start().
    # Accept native POSIX paths, Windows drive paths, and UNC paths without
    # resolving or touching the supervisor's filesystem.
    if not value or not (Path(value).is_absolute() or ntpath.isabs(value)):
        raise ValueError("external worker requires an absolute workspace_path on the bridge machine")
    return value


def _conversation_id(task, board: str) -> str:
    """Keep retries for one card together without coupling separate Matrix cards."""
    return f"hermes-task:{board}:{task.id}"


def _resume_session_id(body: str | None) -> str | None:
    """Return the opt-in Control Plane session ID from a strictly formed directive."""
    text = body or ""
    marker_count = text.count(_RESUME_MARKER)
    if marker_count == 0:
        return None
    matches = list(_RESUME_DIRECTIVE.finditer(text))
    if marker_count != 1 or len(matches) != 1:
        raise ValueError(
            "invalid agent-bridge-worker resume directive; expected exactly:\n"
            "<!-- agent-bridge-worker\nresume-session-id: <Control Plane sessionId>\n-->"
        )
    return matches[0].group(1)


def _prompt(conn, task_id: str, source_status: str) -> str:
    from hermes_cli.kanban_db import build_worker_context

    role = "review worker" if source_status == "review" else "implementation worker"
    return build_worker_context(conn, task_id) + (
        "\n## Worker contract\n"
        f"You are the remote Codex {role} for this card. Work in the supplied directory, "
        "complete the requested task, verify the result, and end with a concise summary of changes and "
        "checks. Do not modify the Hermes Kanban database or call kanban lifecycle tools; the local "
        "supervisor owns claim, heartbeat, and completion transitions.\n"
    )


def _event_summary(page: dict[str, Any], previous: str | None) -> tuple[int, str | None]:
    cursor = int(page.get("next") or 0)
    summary = previous
    for wrapper in page.get("events") or ():
        event = wrapper.get("event") if isinstance(wrapper, dict) else None
        if not isinstance(event, dict):
            continue
        candidate = event.get("summary") or event.get("text")
        if isinstance(candidate, str) and candidate.strip():
            summary = candidate.strip()
    return cursor, summary


def _settle(conn, task_id: str, run_id: int, source_status: str, remote_status: str,
            summary: str | None, error: str | None, completion_mode: str, reviewer: str | None) -> bool:
    from hermes_cli.kanban_db import block_task, complete_task, request_review

    if remote_status == "completed":
        text = summary or "Remote Codex worker completed the run."
        if source_status != "review" and completion_mode == "review":
            return bool(request_review(
                conn, task_id, summary=text, reviewer=reviewer, expected_run_id=run_id,
            ))
        return complete_task(conn, task_id, result=text, summary=text, expected_run_id=run_id)
    reason = error or summary or f"Remote Codex worker ended with status {remote_status}."
    return block_task(conn, task_id, reason=reason, kind="transient", expected_run_id=run_id)


def supervise(args: argparse.Namespace) -> int:
    from hermes_cli.kanban_db import claim_review_task, claim_task, get_task, heartbeat_claim
    from hermes_cli.kanban_db_connect import connect_closing
    from hermes_cli.kanban_db_dispatch import _set_worker_pid

    token = os.environ.get(TOKEN_ENV)
    if not token:
        logger.error("%s is not set", TOKEN_ENV)
        return 2
    claimer = f"{socket.gethostname() or 'unknown'}:{os.getpid()}:agent-bridge"
    with connect_closing(board=args.board) as conn:
        task = get_task(conn, args.task_id)
        if task is None or not task.assignee or not task.assignee.startswith(args.worker_prefix):
            return 0
        source_status = task.status
        claim = claim_review_task if source_status == "review" else claim_task
        claimed = claim(conn, task.id, ttl_seconds=args.claim_ttl, claimer=claimer)
        if claimed is None:
            return 0
        run_id = int(claimed.current_run_id)
        _set_worker_pid(conn, task.id, os.getpid())
        try:
            workspace = _remote_workspace(claimed)
            prompt = _prompt(conn, task.id, source_status)
            resume_session_id = _resume_session_id(claimed.body)
            stable_run_id = f"hermes-{args.board}-{task.id}-{run_id}"
            api = WorkerApi(args.api_url, token)
            api.start(
                run_id=stable_run_id,
                task_id=task.id,
                worker_id=claimed.assignee,
                project_path=workspace,
                prompt=prompt,
                resume_session_id=resume_session_id,
                conversation_id=_conversation_id(claimed, args.board),
            )
        except (ValueError, WorkerApiError) as exc:
            _settle(conn, task.id, run_id, source_status, "failed", None, str(exc),
                    args.completion_mode, args.reviewer)
            return 1

        cursor = 0
        summary = None
        next_heartbeat = time.monotonic()
        poll_failed_since = None
        blocked_since = None
        blocked_signature = None
        while True:
            now = time.monotonic()
            if now >= next_heartbeat:
                if not heartbeat_claim(conn, task.id, ttl_seconds=args.claim_ttl, claimer=claimer):
                    try:
                        api.interrupt(stable_run_id)
                    except WorkerApiError:
                        pass
                    return 0
                next_heartbeat = now + args.heartbeat_interval
            try:
                state = api.run(stable_run_id)
                page = api.events(stable_run_id, cursor)
                cursor, summary = _event_summary(page, summary)
            except WorkerApiError as exc:
                logger.warning("poll failed for %s: %s", stable_run_id, exc)
                poll_failed_since = poll_failed_since or time.monotonic()
                if time.monotonic() - poll_failed_since >= args.api_failure_timeout:
                    _settle(
                        conn, task.id, run_id, source_status, "failed", summary,
                        f"Agent Bridge was unreachable for {args.api_failure_timeout:g}s: {exc}",
                        args.completion_mode, args.reviewer,
                    )
                    return 1
                time.sleep(args.poll_interval)
                continue
            poll_failed_since = None
            status = str(state.get("status") or "unknown")
            if status in TERMINAL_STATUSES:
                ok = _settle(
                    conn, task.id, run_id, source_status, status, summary,
                    state.get("error") if isinstance(state.get("error"), str) else None,
                    args.completion_mode, args.reviewer,
                )
                return 0 if ok else 1
            approvals = state.get("approvals")
            signature = (state.get("updatedAt"), cursor)
            reasonless_blocked = status == "blocked" and not state.get("error") and not approvals
            if reasonless_blocked:
                if signature != blocked_signature:
                    blocked_signature = signature
                    blocked_since = time.monotonic()
                elif blocked_since is not None and time.monotonic() - blocked_since >= args.stalled_blocked_timeout:
                    try:
                        api.reclaim(stable_run_id)
                    except WorkerApiError as exc:
                        logger.warning("stale blocked reclaim failed for %s: %s", stable_run_id, exc)
                    blocked_since = time.monotonic()
            else:
                blocked_since = None
                blocked_signature = None
            time.sleep(args.poll_interval)


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    return supervise(_parser().parse_args())


if __name__ == "__main__":
    raise SystemExit(main())
