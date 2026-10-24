#!/usr/bin/env python3
"""Provision isolated notification accounts on the existing HA Mosquitto addon.

The default is a read-only plan. Secrets travel over SSH stdin and are saved only
in root-owned files outside Git. Existing users, ACLs and addon options survive.
"""

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import secrets
import shlex
import subprocess
import time

START = "# BEGIN uctw-message-center-v1"
END = "# END uctw-message-center-v1"
PUBLISHER = "uctw-agent-publisher"
SUBSCRIBER = "uctw-phone-consumer"
BLOCK = f"""{START}
user {PUBLISHER}
topic write uctw/messages/agent-bridge/events
topic write uctw/messages/agent-bridge/state/#

user {SUBSCRIBER}
topic read uctw/messages/agent-bridge/events
topic read uctw/messages/agent-bridge/state/#
{END}
"""


def private_file(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + secrets.token_hex(6) + ".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as output:
        output.write(content)
    os.replace(temporary, path)


def amended_acl(original: str) -> str:
    if START in original or END in original:
        if original.count(START) != 1 or original.count(END) != 1:
            raise RuntimeError("Unexpected notification ACL markers; investigate before changing")
        before, rest = original.split(START, 1)
        current, after = rest.split(END, 1)
        if START + current + END + "\n" != BLOCK:
            raise RuntimeError("Existing notification ACL differs; investigate before changing")
        return original
    if f"user {PUBLISHER}" in original or f"user {SUBSCRIBER}" in original:
        raise RuntimeError("Account already has unmanaged ACL rules; investigate before changing")
    return original.rstrip() + "\n\n" + BLOCK


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="192.168.5.29")
    parser.add_argument("--ssh-key", default="/root/.ssh/ha_ed25519")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--restart-broker", action="store_true")
    args = parser.parse_args()
    if args.restart_broker and not args.apply:
        parser.error("--restart-broker requires --apply")
    ssh = ["ssh", "-i", args.ssh_key, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
           "-o", "ConnectTimeout=5", f"root@{args.host}"]

    def remote(command: str, body: str | None = None) -> str:
        result = subprocess.run(ssh + [command], input=body, text=True, capture_output=True, timeout=25)
        if result.returncode:
            # Neither command stderr nor API bodies are printed: they can include
            # configuration diagnostics. The numeric status is sufficient here.
            raise RuntimeError(f"HA management command failed (exit {result.returncode})")
        return result.stdout

    def supervisor(path: str, body: dict | None = None) -> dict:
        command = ('curl --fail --silent --show-error --connect-timeout 5 --max-time 15 '
                   '-H "Authorization: Bearer $SUPERVISOR_TOKEN" ')
        if body is not None:
            command += '-H "Content-Type: application/json" -X POST --data-binary @- '
        command += shlex.quote("http://supervisor/addons/core_mosquitto/" + path)
        result = json.loads(remote(command, json.dumps(body) if body is not None else None))
        if result.get("result") != "ok":
            raise RuntimeError("Supervisor did not accept the operation")
        return result.get("data", {})

    info = supervisor("info")
    options = info["options"]
    if options.get("customize") != {"active": True, "folder": "mosquitto"}:
        raise RuntimeError("Unexpected Mosquitto custom configuration; investigate before changing")
    acl_path = "/share/mosquitto/accesscontrollist"
    original_acl = remote("cat " + shlex.quote(acl_path))
    updated_acl = amended_acl(original_acl)
    logins = options.get("logins", [])
    accounts = {entry["username"]: entry for entry in logins}
    if len(accounts) != len(logins):
        raise RuntimeError("Duplicate existing MQTT usernames; investigate before changing")
    if START not in original_acl and any(name in accounts for name in [PUBLISHER, SUBSCRIBER]):
        raise RuntimeError("Notification username already exists without managed ACL; investigate before changing")
    print(json.dumps({"mode": "apply" if args.apply else "plan", "brokerState": info.get("state"),
                      "newAccounts": [name for name in [PUBLISHER, SUBSCRIBER] if name not in accounts],
                      "aclChanges": updated_acl != original_acl,
                      "restartRequested": args.restart_broker}, ensure_ascii=False))
    if not args.apply:
        return

    backup = Path("/var/lib/agent-bridge/mqtt-backups") / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    backup.mkdir(parents=True, mode=0o700)
    private_file(backup / "mosquitto-options.json", json.dumps(options))
    private_file(backup / "accesscontrollist", original_acl)
    for name in [PUBLISHER, SUBSCRIBER]:
        if name not in accounts:
            entry = {"username": name, "password": secrets.token_urlsafe(32)}
            logins.append(entry)
            accounts[name] = entry
    options["logins"] = logins
    if updated_acl != original_acl:
        remote('umask 022; cat > /share/mosquitto/accesscontrollist.uctw-new && '
               'chmod 644 /share/mosquitto/accesscontrollist.uctw-new && '
               'mv /share/mosquitto/accesscontrollist.uctw-new /share/mosquitto/accesscontrollist', updated_acl)
    supervisor("options", {"options": options})
    for account, path in [(PUBLISHER, Path("/etc/agent-bridge/messages.env")),
                          (SUBSCRIBER, Path("/etc/uctw-gateway/mqtt.env"))]:
        if path.exists():
            private_file(backup / path.name.replace(".env", "-previous.env"), path.read_text())
        private_file(path, f"MESSAGE_MQTT_URL=mqtt://{args.host}:1883\n"
                          f"MESSAGE_MQTT_USER={account}\n"
                          f"MESSAGE_MQTT_PASSWORD={accounts[account]['password']}\n")
    print("Accounts and ACL configured; root-only environment files written. Backup:", backup)
    if args.restart_broker:
        supervisor("restart", {})
        for _ in range(30):
            if supervisor("info").get("state") == "started":
                print("Mosquitto is started; verify authentication, ACL and persistent sessions before enabling delivery.")
                break
            time.sleep(1)
        else:
            raise RuntimeError("Mosquitto did not return to started; inspect addon state and backup")
    else:
        print("Broker not restarted; new login activation still requires a broker restart.")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError, subprocess.TimeoutExpired) as error:
        # Never dump API responses, subprocess stderr or local environment files.
        if isinstance(error, RuntimeError):
            print(str(error))
        else:
            print("MQTT configuration failed:", type(error).__name__)
        raise SystemExit(1)
