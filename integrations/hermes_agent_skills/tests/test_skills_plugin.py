from __future__ import annotations

import importlib.util
import json
import sqlite3
from pathlib import Path

import pytest

_spec = importlib.util.spec_from_file_location("agent_bridge_skills", Path(__file__).resolve().parents[1] / "__init__.py")
plugin = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(plugin)

SKILLS = {
    "jmyd": [{"name": "regcode-check", "scope": "jmyd", "category": "business", "description": "追溯码核对",
              "path": "scopes/jmyd/business/regcode-check", "files": ["SKILL.md", "references/api.md"]}],
    "_global": [{"name": "openlist", "scope": "_global", "category": "media", "description": "OpenList 外链",
                 "path": "scopes/_global/media/openlist", "files": ["SKILL.md"]}],
    "_agent-dorothy": [{"name": "navidrome", "scope": "_agent-dorothy", "category": "media", "description": "歌单",
                        "path": "scopes/_agent-dorothy/media/navidrome", "files": ["SKILL.md"]}],
}


class FakeControlPlane:
    def __init__(self, down: bool = False):
        self.calls: list[tuple[str, dict]] = []
        self.down = down

    def __call__(self, tool: str, args: dict) -> dict:
        self.calls.append((tool, args))
        if self.down:
            raise plugin.Unavailable("down")
        if tool == "memory_resolve_scope":
            return {"scope": {"!jmyd:x": "jmyd", "!radio:x": "hui-radio"}.get(args["room_id"], "_global")}
        if tool == "skill_index":
            return {"skills": [item for scope in args["scopes"] for item in SKILLS.get(scope, [])]}
        if tool == "skill_search":
            return {"hits": []}
        if tool == "skill_view":
            pool = [item for items in SKILLS.values() for item in items] if args["scopes"] == "all" \
                else [item for scope in args["scopes"] for item in SKILLS.get(scope, [])]
            entry = next((item for item in pool if item["name"] == args["name"]), None)
            if not entry:
                raise ValueError(f"unknown_skill: {args['name']}")
            file = args.get("file", "SKILL.md")
            if file not in entry["files"]:
                raise ValueError(f"unknown_file: {file}")
            return {**entry, "dir": f"/root/agent-skills/{entry['path']}", "file": file, "content": f"{entry['name']}:{file}",
                    "version": "1.0.0", "slash": False}
        if tool in ("skill_write", "skill_patch", "skill_remove_file", "skill_archive"):
            if "API_KEY=" in json.dumps(args):
                raise ValueError("secret_rejected")
            return {"name": args["name"], "scope": args.get("scope", "jmyd"), "path": "scopes/x", "commit": "abc"}
        raise AssertionError(tool)


def make_home(tmp_path: Path) -> Path:
    tmp_path.mkdir(exist_ok=True)
    db = tmp_path / "state.db"
    with sqlite3.connect(db) as con:
        con.execute("create table sessions (id text primary key, chat_id text, source text)")
        con.executemany("insert into sessions values (?, ?, ?)", [
            ("s-jmyd", "!jmyd:x:$thread", "matrix"), ("s-radio", "!radio:x", "matrix"), ("s-cli", None, "cli")])
    return tmp_path


@pytest.fixture
def env(monkeypatch):
    monkeypatch.setenv("AGENT_MEMORY_TOKEN", "writer-token")
    monkeypatch.setenv("AGENT_MEMORY_SELF_SCOPE", "_agent-dorothy")
    monkeypatch.setenv("AGENT_SKILLS_SCOPES", "jmyd")
    monkeypatch.delenv("AGENT_SKILLS_LOAD_ALL", raising=False)


def originals(log: list):
    def make(name):
        return lambda args, **kw: log.append((name, args)) or json.dumps({"success": True, "native": name})
    return {name: make(name) for name in plugin.TOOLS}


def tools(tmp_path, fake, log):
    lib = plugin.SkillLibrary(make_home(tmp_path), originals(log), call=fake)
    return lib, {name: plugin._wrap(name, lib, lib.originals[name]) for name in plugin.TOOLS}


def test_only_pilot_scopes_use_the_library(env, tmp_path):
    fake, log = FakeControlPlane(), []
    lib, wrapped = tools(tmp_path, fake, log)
    assert lib.scope_for("s-jmyd") == "jmyd"
    assert json.loads(wrapped["skills_list"]({}, session_id="s-radio"))["native"] == "skills_list"
    assert json.loads(wrapped["skills_list"]({}, session_id="s-cli"))["native"] == "skills_list"
    listed = json.loads(wrapped["skills_list"]({}, session_id="s-jmyd"))
    assert [item["name"] for item in listed["skills"]] == ["regcode-check", "navidrome", "openlist"]
    assert ("skill_index", {"scopes": ["jmyd", "_agent-dorothy", "_global"]}) in fake.calls
    resolves = [call for call in fake.calls if call[0] == "memory_resolve_scope"]
    wrapped["skills_list"]({}, session_id="s-jmyd")
    assert [call for call in fake.calls if call[0] == "memory_resolve_scope"] == resolves  # cached


def test_skill_view_reads_the_library_and_falls_back_for_local_skills(env, tmp_path):
    fake, log = FakeControlPlane(), []
    _, wrapped = tools(tmp_path, fake, log)
    view = json.loads(wrapped["skill_view"]({"name": "regcode-check"}, session_id="s-jmyd"))
    assert view["skill_dir"] == "/root/agent-skills/scopes/jmyd/business/regcode-check"
    assert view["linked_files"] == ["references/api.md"] and view["content"] == "regcode-check:SKILL.md"
    missing = json.loads(wrapped["skill_view"]({"name": "regcode-check", "file_path": "nope.md"}, session_id="s-jmyd"))
    assert missing["success"] is False and missing["available_files"] == ["SKILL.md", "references/api.md"]
    # A bundled skill only exists locally.
    assert json.loads(wrapped["skill_view"]({"name": "pdf"}, session_id="s-jmyd"))["native"] == "skill_view"
    # Dorothy cannot reach another room's skills.
    assert json.loads(wrapped["skill_view"]({"name": "hui-radio-ops"}, session_id="s-jmyd"))["native"] == "skill_view"


def test_skill_manage_creates_in_the_room_scope_and_maps_actions(env, tmp_path):
    fake, log = FakeControlPlane(), []
    _, wrapped = tools(tmp_path, fake, log)
    result = json.loads(wrapped["skill_manage"]({"operations": [
        {"action": "create", "name": "stock-check", "content": "---\nname: stock-check\ndescription: d\n---\n", "category": "business"},
        {"action": "patch", "name": "regcode-check", "old_string": "a", "new_string": "b"},
        {"action": "write_file", "name": "regcode-check", "file_path": "references/x.md", "file_content": "x"},
        {"action": "remove_file", "name": "regcode-check", "file_path": "references/x.md"},
        {"action": "delete", "name": "regcode-check", "absorbed_into": "stock-check"},
    ]}, session_id="s-jmyd"))
    assert result["success"] is True and len(result["results"]) == 5
    sent = [(name, args) for name, args in fake.calls if name.startswith("skill_") and name not in ("skill_index", "skill_view")]
    assert sent[0] == ("skill_write", {"scope": "jmyd", "name": "stock-check",
                                       "content": "---\nname: stock-check\ndescription: d\n---\n", "category": "business"})
    assert sent[1][0] == "skill_patch" and sent[1][1]["old_text"] == "a" and sent[1][1]["scopes"] == ["jmyd", "_agent-dorothy", "_global"]
    assert sent[2] == ("skill_write", {"scope": "jmyd", "name": "regcode-check", "file": "references/x.md", "content": "x"})
    assert sent[4] == ("skill_archive", {"name": "regcode-check", "scopes": ["jmyd", "_agent-dorothy", "_global"],
                                         "reason": "absorbed into stock-check"})
    # Operations on a local-only skill go to the native tool.
    assert json.loads(wrapped["skill_manage"]({"operations": [{"action": "patch", "name": "pdf", "old_string": "a",
                                                                "new_string": "b"}]}, session_id="s-jmyd"))["native"] == "skill_manage"


def test_skill_manage_reports_rejections_and_outages(env, tmp_path):
    fake, log = FakeControlPlane(), []
    _, wrapped = tools(tmp_path, fake, log)
    rejected = json.loads(wrapped["skill_manage"]({"action": "create", "name": "keys",
                                                   "content": "API_KEY=sk-0123456789abcdef"}, session_id="s-jmyd"))
    assert rejected["success"] is False and "secret_rejected" in rejected["error"]

    down, log = FakeControlPlane(), []
    lib, wrapped = tools(tmp_path / "second", down, log)
    lib.scope_for("s-jmyd")
    down.down = True
    assert json.loads(wrapped["skill_view"]({"name": "x"}, session_id="s-jmyd"))["native"] == "skill_view"
    failed = json.loads(wrapped["skill_manage"]({"action": "create", "name": "x", "content": "c"}, session_id="s-jmyd"))
    assert failed["success"] is False and "not saved" in failed["error"]


def test_disabled_without_token_or_scopes(monkeypatch, tmp_path):
    monkeypatch.setenv("AGENT_MEMORY_TOKEN", "writer-token")
    monkeypatch.delenv("AGENT_SKILLS_SCOPES", raising=False)
    assert not plugin.SkillLibrary(tmp_path, {}, call=FakeControlPlane()).enabled()
    monkeypatch.setenv("AGENT_SKILLS_SCOPES", "all")
    lib = plugin.SkillLibrary(tmp_path, {}, call=FakeControlPlane())
    assert lib.enabled() and lib.routed("anything")
