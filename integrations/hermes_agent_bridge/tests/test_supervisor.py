from __future__ import annotations

from dataclasses import dataclass

import pytest

from integrations.hermes_agent_bridge.supervisor import (
    TERMINAL_STATUSES,
    UPDATE_ADMISSION_STATUSES,
    _conversation_id,
    _event_summary,
    _remote_workspace,
    _settle,
)


@dataclass
class _Task:
    workspace_kind: str
    workspace_path: str | None
    id: str = "t_1"
    session_id: str | None = None


def test_remote_workspace_uses_the_bridge_path_without_touching_local_disk(tmp_path):
    remote_path = tmp_path / "not-created"

    assert _remote_workspace(_Task("dir", str(remote_path))) == str(remote_path)
    assert not remote_path.exists()


@pytest.mark.parametrize("kind", ["scratch", "worktree"])
def test_remote_workspace_rejects_host_owned_workspace_kinds(kind):
    with pytest.raises(ValueError, match="workspace_kind=dir"):
        _remote_workspace(_Task(kind, "/work/repo"))


def test_event_summary_advances_cursor_and_keeps_latest_useful_text():
    cursor, summary = _event_summary({
        "next": 7,
        "events": [
            {"event": {"type": "agent.progress", "text": "running tests"}},
            {"event": {"type": "agent.completed", "summary": "fixed and verified"}},
        ],
    }, None)

    assert cursor == 7
    assert summary == "fixed and verified"


def test_conversation_id_prefers_originating_session_with_per_card_fallback():
    assert _conversation_id(_Task("dir", "/work/repo", session_id="matrix:room:thread"), "main") == "matrix:room:thread"
    assert _conversation_id(_Task("dir", "/work/repo", id="t_9"), "main") == "hermes-task:main:t_9"


def test_update_admission_states_never_settle_a_hermes_claim():
    assert UPDATE_ADMISSION_STATUSES.isdisjoint(TERMINAL_STATUSES)


def test_completed_remote_run_closes_the_owned_kanban_run(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "hermes"))
    from hermes_cli.kanban_db import claim_task, create_board, create_task, get_task, unblock_task
    from hermes_cli.kanban_db_connect import connect_closing

    create_board("bridge-test")
    with connect_closing(board="bridge-test") as conn:
        task_id = create_task(
            conn,
            title="Fix tests",
            assignee="codex@dev",
            workspace_kind="dir",
            workspace_path="/work/repo",
            initial_status="blocked",
            board="bridge-test",
        )
        assert unblock_task(conn, task_id)
        claimed = claim_task(conn, task_id, claimer="test:1", ttl_seconds=900)
        assert claimed is not None and claimed.current_run_id is not None

        assert _settle(
            conn,
            task_id,
            int(claimed.current_run_id),
            "ready",
            "completed",
            "fixed and verified",
            None,
            "done",
            None,
        )
        task = get_task(conn, task_id)

    assert task is not None
    assert task.status == "done"
    assert task.result == "fixed and verified"
