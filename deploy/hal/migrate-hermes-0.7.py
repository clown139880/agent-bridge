"""Agent Bridge 0.7: switch Hermes profiles from `abctl mcp` to the /mcp/bridge endpoint.
Usage: python migrate-0.7.py [--apply] [home ...]   (default: dry run on /root/.hermes and its dorothy profile)"""
import re, shutil, sys, time
import yaml

RENAME = {"ab_workers": "workers", "ab_sessions": "sessions", "ab_session": "session", "ab_create_session": "create",
          "ab_send": "turn", "ab_wait": "wait", "ab_pending": "pending", "ab_decide": "approve", "ab_answer": "answer",
          "ab_interrupt": "interrupt"}
OLD = re.compile(r"^  agent-bridge:\n    command: /usr/local/bin/abctl\n    args:\n      - mcp\n(?:    timeout: \d+\n)?", re.M)
NEW = ("  bridge:\n    url: http://127.0.0.1:8787/mcp/bridge\n    headers:\n"
       "      Authorization: Bearer ${AGENT_BRIDGE_CONTROL_TOKEN}\n    timeout: 660\n")

def token() -> str:
    env = dict(re.findall(r"^([A-Z_]+)=(.*)$", open("/root/agent-bridge/.env").read(), re.M))
    return env["CONTROL_API_WRITE_TOKEN"].strip().strip('"')

def migrate(home: str, apply: bool) -> None:
    cfg = f"{home}/config.yaml"
    text = open(cfg).read()
    if "/mcp/bridge" in text:
        print(cfg, "already migrated")
    else:
        new, n = OLD.subn(NEW, text)
        assert n == 1, f"{cfg}: agent-bridge block not found"
        for old, short in RENAME.items():
            new = re.sub(rf"^(\s+- ){old}$", rf"\g<1>{short}", new, flags=re.M)
        new = re.sub(r"^(\s+- )mcp-agent-bridge$", r"\g<1>mcp-bridge", new, flags=re.M)
        servers = yaml.safe_load(new)["mcp_servers"]
        assert "agent-bridge" not in servers and servers["bridge"]["url"].endswith("/mcp/bridge")
        assert "ab_" not in new and "mcp-agent-bridge" not in new
        print(cfg, "->", servers["bridge"].get("tools", "all tools"))
        if apply:
            shutil.copy2(cfg, f"{cfg}.bak-0.7-{time.strftime('%Y%m%d%H%M%S')}")
            open(cfg, "w").write(new)
    env = f"{home}/.env"
    if re.search(r"^AGENT_BRIDGE_CONTROL_TOKEN=", open(env).read(), re.M):
        print(env, "token already set")
    else:
        print(env, "adds AGENT_BRIDGE_CONTROL_TOKEN")
        if apply:
            text = open(env).read()
            open(env, "w").write(text + ("" if text.endswith("\n") else "\n") + f"AGENT_BRIDGE_CONTROL_TOKEN={token()}\n")

args = [a for a in sys.argv[1:] if a != "--apply"]
for home in args or ["/root/.hermes", "/root/.hermes/profiles/dorothy"]:
    migrate(home, "--apply" in sys.argv)
