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


def test_session_context_reads_session_and_tail_events(monkeypatch):
    api = WorkerApi("http://bridge", "secret")
    calls = []

    def request(method, path, body=None):
        calls.append((method, path, body))
        return {"sessionId": "a/b"} if path.endswith("a%2Fb") else {"data": [{"type": "agent.completed"}]}

    monkeypatch.setattr(api, "_request", request)

    assert api.session_context("a/b") == {
        "session": {"sessionId": "a/b"},
        "events": {"data": [{"type": "agent.completed"}]},
    }
    assert calls == [
        ("GET", "/api/v1/sessions/a%2Fb", None),
        ("GET", "/api/v1/sessions/a%2Fb/events?tail=true", None),
    ]
