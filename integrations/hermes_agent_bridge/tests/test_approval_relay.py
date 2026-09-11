from __future__ import annotations

import asyncio
import threading
from types import SimpleNamespace

import integrations.hermes_agent_bridge.approval_relay as relay_module
from integrations.hermes_agent_bridge.approval_relay import (
    ApprovalRelay,
    PendingRemoteApproval,
    _approval_choice,
    _owned_subscription,
)


def _approval() -> PendingRemoteApproval:
    return PendingRemoteApproval(
        board="default",
        task_id="t_1",
        assignee="codex@hal",
        run_id="hermes-default-t_1-1",
        approval_id="a_1",
        kind="command",
        summary="Run the test suite",
        choices=("allow", "allow-session", "deny"),
        session_key="agent:main:matrix:dm:room",
        subscription={"platform": "matrix", "chat_id": "!room:example", "notifier_profile": "default"},
    )


def test_remote_choices_map_to_bridge_protocol_fail_closed():
    offered = ("allow", "allow-session", "deny")
    assert _approval_choice("once", offered) == "allow"
    assert _approval_choice("session", offered) == "allow-session"
    assert _approval_choice("always", offered) == "allow-session"
    assert _approval_choice("deny", offered) == "deny"
    assert _approval_choice(None, offered) == "deny"
    assert _approval_choice("session", ("allow", "deny")) == "deny"


def test_subscription_routing_never_crosses_profiles_or_claims_legacy_rows():
    subs = [
        {"notifier_profile": None, "chat_id": "legacy"},
        {"notifier_profile": "dorothy", "chat_id": "dorothy-room"},
        {"notifier_profile": "default", "chat_id": "default-room"},
    ]
    assert _owned_subscription(subs, "default")["chat_id"] == "default-room"
    assert _owned_subscription(subs, "dorothy")["chat_id"] == "dorothy-room"
    assert _owned_subscription(subs, "xiaoq") is None


def test_relay_posts_one_correlated_decision_and_suppresses_duplicate(monkeypatch):
    approval = _approval()
    posted = []

    class Api:
        def approve(self, run_id, approval_id, choice):
            posted.append((run_id, approval_id, choice))
            return {"accepted": True}

    relay = ApprovalRelay(
        api=Api(),
        profile_name="default",
        worker_prefixes=("codex@",),
        poll_interval=1,
        scan=lambda *_args: [approval],
        present=lambda _profile, _approval: "allow-session",
    )

    class ImmediateThread:
        def __init__(self, *, target, args, **_kwargs):
            self.target, self.args = target, args

        def start(self):
            self.target(*self.args)

    monkeypatch.setattr("integrations.hermes_agent_bridge.approval_relay.threading.Thread", ImmediateThread)
    relay.tick()
    relay.tick()

    assert posted == [(approval.run_id, approval.approval_id, "allow-session")]


def test_unavailable_gateway_leaves_remote_approval_pending():
    approval = _approval()

    class Api:
        def approve(self, *_args):
            raise AssertionError("must not answer without a live Hermes approval surface")

    relay = ApprovalRelay(
        api=Api(), profile_name="default", worker_prefixes=("codex@",), poll_interval=1,
        scan=lambda *_args: [], present=lambda *_args: None,
    )
    relay._inflight.add((approval.run_id, approval.approval_id))
    relay._handle(approval)
    assert not relay._inflight


def test_native_presenter_round_trips_through_hermes_gateway_queue(monkeypatch):
    loop = asyncio.new_event_loop()
    started = threading.Event()

    def run_loop():
        asyncio.set_event_loop(loop)
        started.set()
        loop.run_forever()

    loop_thread = threading.Thread(target=run_loop, daemon=True)
    loop_thread.start()
    started.wait(1)

    class Adapter:
        is_connected = True

        async def send_exec_approval(self, **kwargs):
            from tools.approval import resolve_gateway_approval

            assert kwargs["allow_permanent"] is False
            assert kwargs["allow_session"] is True
            assert resolve_gateway_approval(kwargs["session_key"], "session") == 1
            return SimpleNamespace(success=True)

    monkeypatch.setattr(relay_module, "_gateway_target", lambda *_args: (Adapter(), loop))
    try:
        assert relay_module._present_native("default", _approval()) == "allow-session"
    finally:
        loop.call_soon_threadsafe(loop.stop)
        loop_thread.join(timeout=1)
