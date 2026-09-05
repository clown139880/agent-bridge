"""Small standard-library client for the Agent Bridge worker API."""

from __future__ import annotations

import json
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen


class WorkerApiError(RuntimeError):
    pass


class WorkerApi:
    def __init__(self, base_url: str, token: str, *, timeout: float = 15) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout = timeout

    def _request(self, method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        data = json.dumps(body).encode() if body is not None else None
        request = Request(
            self.base_url + path,
            data=data,
            method=method,
            headers={
                "Authorization": f"Bearer {self.token}",
                "Accept": "application/json",
                **({"Content-Type": "application/json"} if data is not None else {}),
            },
        )
        try:
            with urlopen(request, timeout=self.timeout) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise WorkerApiError(f"Agent Bridge returned HTTP {exc.code}: {detail[:500]}") from exc
        except (URLError, TimeoutError, json.JSONDecodeError) as exc:
            raise WorkerApiError(f"Agent Bridge request failed: {exc}") from exc
        if not isinstance(payload, dict):
            raise WorkerApiError("Agent Bridge returned a non-object JSON response")
        return payload

    def workers(self) -> list[dict[str, Any]]:
        payload = self._request("GET", "/api/v1/workers")
        workers = payload.get("workers")
        if not isinstance(workers, list):
            raise WorkerApiError("Agent Bridge workers response is malformed")
        return [item for item in workers if isinstance(item, dict)]

    def start(self, *, run_id: str, task_id: str, worker_id: str, project_path: str, prompt: str,
              resume_session_id: str | None = None, conversation_id: str | None = None) -> dict[str, Any]:
        body = {
            "runId": run_id,
            "taskId": task_id,
            "workerId": worker_id,
            "projectPath": project_path,
            "prompt": prompt,
        }
        if resume_session_id:
            body["resumeSessionId"] = resume_session_id
        if conversation_id:
            body["conversationId"] = conversation_id
        return self._request("POST", "/api/v1/runs", body)

    def run(self, run_id: str) -> dict[str, Any]:
        return self._request("GET", f"/api/v1/runs/{quote(run_id, safe='')}")

    def events(self, run_id: str, after: int) -> dict[str, Any]:
        return self._request("GET", f"/api/v1/runs/{quote(run_id, safe='')}/events?after={after}")

    def interrupt(self, run_id: str) -> dict[str, Any]:
        return self._request("POST", f"/api/v1/runs/{quote(run_id, safe='')}/interrupt", {})

    def approve(self, run_id: str, approval_id: str, choice: str) -> dict[str, Any]:
        return self._request(
            "POST",
            f"/api/v1/runs/{quote(run_id, safe='')}/approvals/{quote(approval_id, safe='')}",
            {"choice": choice},
        )
