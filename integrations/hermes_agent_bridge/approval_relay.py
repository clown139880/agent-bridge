"""Relay remote Codex approvals through Hermes' native gateway approval UX.

The dispatcher and the chat which created a card can belong to different Hermes
profiles.  Each profile therefore watches only its own durable Kanban notification
subscriptions and presents approvals through its own live gateway adapter.
"""

from __future__ import annotations

import asyncio
import logging
import threading
from dataclasses import dataclass
from typing import Any, Callable

from .worker_api import WorkerApi, WorkerApiError

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class PendingRemoteApproval:
    board: str
    task_id: str
    assignee: str
    run_id: str
    approval_id: str
    kind: str
    summary: str
    choices: tuple[str, ...]
    session_key: str
    subscription: dict[str, Any]


def _owned_subscription(subs: list[dict[str, Any]], profile_name: str) -> dict[str, Any] | None:
    """Pick a route owned by this profile; never steal legacy/unowned routes."""
    for sub in subs:
        if str(sub.get("notifier_profile") or "") == profile_name:
            return sub
    return None


def _approval_choice(choice: str | None, offered: tuple[str, ...]) -> str:
    if choice == "once" and "allow" in offered:
        return "allow"
    if choice in {"session", "always"} and "allow-session" in offered:
        return "allow-session"
    return "deny"


def _pending_approvals(
    api: WorkerApi, profile_name: str, worker_prefix: str,
) -> list[PendingRemoteApproval]:
    from hermes_cli.kanban_db import list_boards, list_tasks
    from hermes_cli.kanban_db_connect import connect_closing
    from hermes_cli.kanban_db_notify import list_notify_subs

    pending: list[PendingRemoteApproval] = []
    for board_info in list_boards(include_archived=False):
        board = str(board_info.get("slug") or "")
        if not board:
            continue
        with connect_closing(board=board) as conn:
            tasks = list_tasks(conn, status="running")
            for task in tasks:
                assignee = str(task.assignee or "")
                if not assignee.lower().startswith(worker_prefix) or task.current_run_id is None:
                    continue
                sub = _owned_subscription(list_notify_subs(conn, task.id), profile_name)
                if sub is None:
                    continue
                run_id = f"hermes-{board}-{task.id}-{int(task.current_run_id)}"
                try:
                    state = api.run(run_id)
                except WorkerApiError as exc:
                    logger.debug("approval relay could not poll %s: %s", run_id, exc)
                    continue
                for approval in state.get("approvals") or ():
                    if not isinstance(approval, dict) or not approval.get("approvalId"):
                        continue
                    pending.append(PendingRemoteApproval(
                        board=board,
                        task_id=task.id,
                        assignee=assignee,
                        run_id=run_id,
                        approval_id=str(approval["approvalId"]),
                        kind=str(approval.get("kind") or "operation"),
                        summary=str(approval.get("summary") or "Remote Codex operation"),
                        choices=tuple(str(c) for c in approval.get("choices") or ()),
                        session_key=str(task.session_id or f"agent-bridge:{board}:{task.id}"),
                        subscription=sub,
                    ))
    return pending


def _gateway_target(profile_name: str, sub: dict[str, Any]):
    """Resolve this profile's live adapter and event loop without crossing profiles."""
    from gateway.config import Platform
    from gateway.run import _gateway_runner_ref

    runner = _gateway_runner_ref()
    if runner is None or getattr(runner, "_gateway_loop", None) is None:
        return None
    try:
        platform = Platform(str(sub.get("platform") or "").lower())
    except ValueError:
        return None
    resolver = getattr(runner, "_authorization_adapter", None)
    adapter = resolver(platform, profile_name) if callable(resolver) else getattr(runner, "adapters", {}).get(platform)
    if adapter is None or not getattr(adapter, "is_connected", False):
        return None
    return adapter, runner._gateway_loop


def _present_native(profile_name: str, approval: PendingRemoteApproval) -> str | None:
    """Block on Hermes' standard gateway queue and return a bridge wire choice."""
    target = _gateway_target(profile_name, approval.subscription)
    if target is None:
        return None
    adapter, loop = target
    if getattr(type(adapter), "send_exec_approval", None) is None:
        return None

    sub = approval.subscription
    metadata = dict(sub.get("delivery_metadata") or {})
    if sub.get("thread_id") and not metadata.get("thread_id"):
        metadata["thread_id"] = sub["thread_id"]
    if sub.get("user_id") and not metadata.get("requester_user_id"):
        metadata["requester_user_id"] = sub["user_id"]

    def notify(data: dict[str, Any]) -> None:
        from gateway.run import _redact_approval_command

        result = asyncio.run_coroutine_threadsafe(
            adapter.send_exec_approval(
                chat_id=str(sub["chat_id"]),
                command=_redact_approval_command(str(data.get("command") or "")),
                session_key=approval.session_key,
                description=str(data.get("description") or "remote Codex operation"),
                metadata=metadata,
                allow_permanent=False,
                allow_session="allow-session" in approval.choices,
            ),
            loop,
        ).result(timeout=15)
        if getattr(result, "success", True) is False:
            raise RuntimeError(getattr(result, "error", None) or "approval prompt delivery failed")

    from tools.approval_gateway_wait import _await_gateway_decision

    decision = _await_gateway_decision(
        approval.session_key,
        notify,
        {
            "command": approval.summary,
            "description": f"Remote Codex {approval.kind} · {approval.assignee} · card {approval.task_id}",
            "pattern_key": approval.approval_id,
            "pattern_keys": [approval.approval_id],
            "allow_permanent": False,
            "allow_session": "allow-session" in approval.choices,
        },
        surface="gateway",
    )
    return _approval_choice(decision.get("choice") if decision.get("resolved") else None, approval.choices)


class ApprovalRelay:
    def __init__(
        self,
        *,
        api: WorkerApi,
        profile_name: str,
        worker_prefix: str,
        poll_interval: float,
        scan: Callable[..., list[PendingRemoteApproval]] = _pending_approvals,
        present: Callable[[str, PendingRemoteApproval], str | None] = _present_native,
    ) -> None:
        self.api = api
        self.profile_name = profile_name
        self.worker_prefix = worker_prefix
        self.poll_interval = poll_interval
        self.scan = scan
        self.present = present
        self.stop_event = threading.Event()
        self._inflight: set[tuple[str, str]] = set()
        # A 202 means the decision has crossed the control-plane boundary.  Keep
        # it suppressed even if the bridge takes another poll to emit resolved.
        self._answered: set[tuple[str, str]] = set()
        self._lock = threading.Lock()

    def stop(self) -> None:
        self.stop_event.set()

    def _handle(self, approval: PendingRemoteApproval) -> None:
        key = (approval.run_id, approval.approval_id)
        try:
            choice = self.present(self.profile_name, approval)
            if choice is not None:
                self.api.approve(approval.run_id, approval.approval_id, choice)
                with self._lock:
                    self._answered.add(key)
        except Exception as exc:
            logger.warning("approval relay failed for %s/%s: %s", *key, exc)
        finally:
            with self._lock:
                self._inflight.discard(key)

    def tick(self) -> None:
        for approval in self.scan(self.api, self.profile_name, self.worker_prefix):
            key = (approval.run_id, approval.approval_id)
            with self._lock:
                if key in self._inflight or key in self._answered:
                    continue
                self._inflight.add(key)
            threading.Thread(
                target=self._handle,
                args=(approval,),
                name=f"agent-bridge-approval-{approval.approval_id[:8]}",
                daemon=True,
            ).start()

    def run(self) -> None:
        while not self.stop_event.is_set():
            try:
                self.tick()
            except Exception:
                logger.debug("approval relay scan failed", exc_info=True)
            self.stop_event.wait(self.poll_interval)
