from __future__ import annotations

from types import SimpleNamespace

import integrations.hermes_agent_bridge as plugin


def test_dispatch_tick_only_starts_matching_external_lanes(monkeypatch):
    started = []
    settings = {
        "worker_prefix": "codex@",
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
        {"worker_prefix": "codex@", "max_in_progress": 1},
        board="main",
        result=SimpleNamespace(skipped_nonspawnable=["task-a"]),
    )
