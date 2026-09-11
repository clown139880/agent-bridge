from __future__ import annotations

from types import SimpleNamespace

import integrations.hermes_agent_bridge as plugin


def test_dispatch_tick_only_starts_matching_external_lanes(monkeypatch):
    started = []
    settings = {
        "worker_prefixes": ("codex@",),
        "max_in_progress": 2,
        "api_url": "http://127.0.0.1:8787",
        "poll_interval": 3,
        "heartbeat_interval": 30,
        "claim_ttl": 900,
        "failure_timeout": 300,
        "completion_mode": "done",
        "reviewer": None,
    }
    monkeypatch.setenv(plugin._TOKEN_ENV, "secret")
    monkeypatch.setattr(plugin, "_children", {})
    monkeypatch.setattr(plugin, "_matches_lane", lambda task_id, _board, _prefix: task_id != "other")
    monkeypatch.setattr(plugin, "_spawn_supervisor", lambda task_id, board, _settings: started.append((task_id, board)))

    plugin._dispatch_tick(
        settings,
        board="main",
        result=SimpleNamespace(skipped_nonspawnable=["task-a", "other", "task-b", "task-c"]),
    )

    assert started == [("task-a", "main"), ("task-b", "main")]


def test_dispatch_tick_does_nothing_without_secret(monkeypatch):
    monkeypatch.delenv(plugin._TOKEN_ENV, raising=False)
    monkeypatch.setattr(plugin, "_spawn_supervisor", lambda *_args: (_ for _ in ()).throw(AssertionError()))

    plugin._dispatch_tick(
        {"worker_prefixes": ("codex@",), "max_in_progress": 1},
        board="main",
        result=SimpleNamespace(skipped_nonspawnable=["task-a"]),
    )


def test_normalize_prefixes_parses_multiple_lanes_and_defaults():
    assert plugin._normalize_prefixes("codex@") == ("codex@",)
    assert plugin._normalize_prefixes("codex@,claude@") == ("codex@", "claude@")
    # Whitespace, case, blanks, and duplicates are all normalized away.
    assert plugin._normalize_prefixes(" Codex@ , claude@ ,, codex@ ") == ("codex@", "claude@")
    assert plugin._normalize_prefixes(["Codex@", "CLAUDE@"]) == ("codex@", "claude@")
    assert plugin._normalize_prefixes("") == ("codex@",)
    assert plugin._normalize_prefixes(None) == ("codex@",)


def test_matches_lane_recognizes_every_configured_prefix(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "hermes"))
    from hermes_cli.kanban_db import create_board, create_task
    from hermes_cli.kanban_db_connect import connect_closing

    board = "special-forces"
    create_board(board)
    with connect_closing(board=board) as conn:
        claude_task = create_task(
            conn, title="Claude lane", assignee="claude@hal",
            workspace_kind="dir", workspace_path="/work/repo", board=board,
        )
        codex_task = create_task(
            conn, title="Codex lane", assignee="codex@dev",
            workspace_kind="dir", workspace_path="/work/repo", board=board,
        )
        other_task = create_task(
            conn, title="Human lane", assignee="alice",
            workspace_kind="dir", workspace_path="/work/repo", board=board,
        )

    # codex@-only config leaves the claude@ special-forces card unclaimed...
    assert not plugin._matches_lane(claude_task, board, ("codex@",))
    assert plugin._matches_lane(codex_task, board, ("codex@",))
    # ...while a multi-prefix config claims both agent lanes but not humans.
    assert plugin._matches_lane(claude_task, board, ("codex@", "claude@"))
    assert plugin._matches_lane(codex_task, board, ("codex@", "claude@"))
    assert not plugin._matches_lane(other_task, board, ("codex@", "claude@"))


def test_register_exposes_all_read_only_discovery_tools(monkeypatch):
    monkeypatch.delenv(plugin._TOKEN_ENV, raising=False)
    registered = []

    class Context:
        profile_name = "test"

        def get_config(self, _name, default=None):
            return default

        def register_hook(self, *_args, **_kwargs):
            pass

        def register_tool(self, **kwargs):
            registered.append(kwargs)

    plugin.register(Context())

    assert [item["name"] for item in registered] == [
        "agent_bridge_workers",
        "agent_bridge_sessions",
        "agent_bridge_session_context",
    ]
    assert all(item["toolset"] == "agent_bridge" for item in registered)
