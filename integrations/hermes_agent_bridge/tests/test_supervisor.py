from __future__ import annotations

from dataclasses import dataclass
from types import SimpleNamespace

import pytest

from integrations.hermes_agent_bridge.supervisor import (
    TERMINAL_STATUSES,
    UPDATE_ADMISSION_STATUSES,
    _conversation_id,
    _event_summary,
    _remote_workspace,
    _resume_session_id,
    _settle,
    supervise,
)


@dataclass
class _Task:
    workspace_kind: str
    workspace_path: str | None
    id: str = "t_1"
    session_id: str | None = None
    body: str | None = None


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


def test_conversation_id_is_always_scoped_to_the_card():
    assert _conversation_id(_Task("dir", "/work/repo", session_id="matrix:room:thread"), "main") == "hermes-task:main:t_1"
    assert _conversation_id(_Task("dir", "/work/repo", id="t_9"), "main") == "hermes-task:main:t_9"


def test_resume_directive_is_strictly_parsed():
    body = "Before\n\n<!-- agent-bridge-worker\nresume-session-id: session-123\n-->\n"

    assert _resume_session_id(body) == "session-123"
    assert _resume_session_id("No directive") is None


@pytest.mark.parametrize("body", [
    "<!-- agent-bridge-worker\nresume-session-id: \n-->",
    "<!-- agent-bridge-worker\nresume-session-id: one\nresume-session-id: two\n-->",
    "<!-- agent-bridge-worker\nresume-session-id: one\n-->\n<!-- agent-bridge-worker\nresume-session-id: two\n-->",
    "<!-- agent-bridge-worker resume-session-id: one -->",
])
def test_malformed_resume_directive_is_rejected(body):
    with pytest.raises(ValueError, match="invalid agent-bridge-worker resume directive"):
        _resume_session_id(body)


def _supervisor_args(task_id: str, board: str) -> SimpleNamespace:
    return SimpleNamespace(
        task_id=task_id,
        board=board,
        api_url="http://127.0.0.1:8787",
        poll_interval=0,
        heartbeat_interval=30,
        claim_ttl=900,
        api_failure_timeout=300,
        stalled_blocked_timeout=300,
        completion_mode="done",
        reviewer=None,
        worker_prefix="codex@",
    )


@pytest.mark.parametrize("body, expected_resume", [
    ("<!-- agent-bridge-worker\nresume-session-id: dsh-session\n-->", "dsh-session"),
    ("ordinary card body", None),
])
def test_supervisor_passes_explicit_resume_only(tmp_path, monkeypatch, body, expected_resume):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "hermes"))
    monkeypatch.setenv("AGENT_BRIDGE_WORKER_API_TOKEN", "secret")
    from hermes_cli.kanban_db import create_board, create_task
    from hermes_cli.kanban_db_connect import connect_closing
    import integrations.hermes_agent_bridge.supervisor as supervisor_module

    board = "resume-test"
    create_board(board)
    with connect_closing(board=board) as conn:
        task_id = create_task(
            conn,
            title="Resume remote work",
            body=body,
            assignee="codex@dev",
            workspace_kind="dir",
            workspace_path="/work/repo",
            board=board,
        )

    starts = []

    class FakeApi:
        def __init__(self, *_args, **_kwargs):
            pass

        def start(self, **kwargs):
            starts.append(kwargs)
            return {}

        def run(self, _run_id):
            return {"status": "completed"}

        def events(self, _run_id, _after):
            return {"next": 0, "events": []}

    monkeypatch.setattr(supervisor_module, "WorkerApi", FakeApi)

    assert supervise(_supervisor_args(task_id, board)) == 0
    assert starts[0]["resume_session_id"] == expected_resume
    assert starts[0]["conversation_id"] == f"hermes-task:{board}:{task_id}"


def test_malformed_resume_directive_blocks_before_start(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "hermes"))
    monkeypatch.setenv("AGENT_BRIDGE_WORKER_API_TOKEN", "secret")
    from hermes_cli.kanban_db import create_board, create_task, get_task, list_events
    from hermes_cli.kanban_db_connect import connect_closing
    import integrations.hermes_agent_bridge.supervisor as supervisor_module

    board = "bad-resume-test"
    create_board(board)
    with connect_closing(board=board) as conn:
        task_id = create_task(
            conn,
            title="Bad resume",
            body="<!-- agent-bridge-worker\nresume-session-id: \n-->",
            assignee="codex@dev",
            workspace_kind="dir",
            workspace_path="/work/repo",
            board=board,
        )

    class UnexpectedApi:
        def __init__(self, *_args, **_kwargs):
            raise AssertionError("WorkerApi must not be constructed")

    monkeypatch.setattr(supervisor_module, "WorkerApi", UnexpectedApi)

    assert supervise(_supervisor_args(task_id, board)) == 1
    with connect_closing(board=board) as conn:
        task = get_task(conn, task_id)
        events = list_events(conn, task_id)
    assert task.status == "blocked"
    blocked = next(event for event in events if event.kind == "blocked")
    assert "invalid agent-bridge-worker resume directive" in blocked.payload["reason"]


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
