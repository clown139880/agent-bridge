from __future__ import annotations

from integrations.hermes_agent_bridge.worker_api import WorkerApi


def test_sessions_forwards_supported_filters(monkeypatch):
    api = WorkerApi("http://bridge", "secret")
    calls = []
    monkeypatch.setattr(api, "_request", lambda method, path, body=None: calls.append((method, path, body)) or {"data": []})

    result = api.sessions(
        worker_id="codex@dev box",
        workspace="/work/a repo",
        q="fix tests",
        task_id="t_1",
        active=False,
        limit=25,
    )

    assert result == {"data": []}
    assert calls == [(
        "GET",
        "/api/v1/sessions?workerId=codex%40dev+box&workspace=%2Fwork%2Fa+repo&q=fix+tests&taskId=t_1&active=false&limit=25",
        None,
    )]


def test_session_context_reads_session_and_only_the_last_turn_completed(monkeypatch):
    api = WorkerApi("http://bridge", "secret")
    calls = []
    completed = {"type": "turn.completed", "payload": {"status": "completed", "summary": "report"}}

    def request(method, path, body=None):
        calls.append((method, path, body))
        if path.endswith("a%2Fb"):
            return {"sessionId": "a/b"}
        return {"data": [completed], "hasMore": True, "nextCursor": "e:1", "streamCursor": "e:9"}

    monkeypatch.setattr(api, "_request", request)

    assert api.session_context("a/b") == {"session": {"sessionId": "a/b"}, "lastTurnCompleted": completed}
    assert calls == [
        ("GET", "/api/v1/sessions/a%2Fb", None),
        ("GET", "/api/v1/sessions/a%2Fb/events?tail=true&type=turn.completed&limit=1", None),
    ]


def test_session_context_without_a_completed_turn(monkeypatch):
    api = WorkerApi("http://bridge", "secret")
    monkeypatch.setattr(api, "_request", lambda method, path, body=None:
                        {"sessionId": "s"} if path.endswith("/s") else {"data": []})

    assert api.session_context("s") == {"session": {"sessionId": "s"}, "lastTurnCompleted": None}


def test_start_includes_the_model_only_when_pinned(monkeypatch):
    api = WorkerApi("http://bridge", "secret")
    calls = []
    monkeypatch.setattr(api, "_request", lambda method, path, body=None: calls.append((method, path, body)) or {})

    api.start(run_id="r1", task_id="t_1", worker_id="pi@hal",
              project_path="/work/repo", prompt="do it")
    api.start(run_id="r2", task_id="t_1", worker_id="pi@hal",
              project_path="/work/repo", prompt="do it",
              model="tokensapi/deepseek-v4-flash-vision-exp")

    assert "model" not in calls[0][2]
    assert calls[1][2]["model"] == "tokensapi/deepseek-v4-flash-vision-exp"
