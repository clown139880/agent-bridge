#!/usr/bin/env python3
"""Update Codex defaults from WSL. Preview unless --apply is given; Python 3.11+."""

import argparse
import base64
import copy
import json
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tomllib


# Runs locally or via SSH with only the Python standard library (Python 3.8+).
# Config contents travel over stdin/stdout captured by this process, never argv.
FILE_HELPER = r'''
import base64, hashlib, json, os, pathlib, secrets, stat, sys, tempfile
from datetime import datetime, timezone

def digest(data):
    return hashlib.sha256(data).hexdigest()

def run(req):
    raw_path = req.get("path") or str(pathlib.Path(os.environ.get("CODEX_HOME") or str(pathlib.Path.home() / ".codex")) / "config.toml")
    path = pathlib.Path(raw_path).expanduser().resolve(strict=True)
    info = path.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_size > 4 * 1024 * 1024:
        raise ValueError("expected a regular config file no larger than 4 MiB")
    original = path.read_bytes()
    if req["op"] == "read":
        return {"path": str(path), "sha256": digest(original), "content": base64.b64encode(original).decode("ascii")}
    if req["op"] != "write":
        raise ValueError("unknown operation")
    if str(path) != req["expected_path"] or digest(original) != req["expected_sha256"]:
        raise ValueError("config changed since preview; rerun before writing")
    updated = base64.b64decode(req["content"], validate=True)
    if updated == original:
        return {"path": str(path), "status": "unchanged"}
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    backup = path.with_name(path.name + ".bak.model-" + stamp + "-" + secrets.token_hex(4))
    with os.fdopen(os.open(str(backup), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as stream:
        stream.write(original)
        stream.flush()
        os.fsync(stream.fileno())
    temporary = None
    try:
        fd, temporary = tempfile.mkstemp(prefix="." + path.name + ".model-", dir=str(path.parent))
        with os.fdopen(fd, "wb") as stream:
            stream.write(updated)
            stream.flush()
            os.fsync(stream.fileno())
        tmp_info = os.stat(temporary)
        if (tmp_info.st_uid, tmp_info.st_gid) != (info.st_uid, info.st_gid):
            os.chown(temporary, info.st_uid, info.st_gid)
        os.chmod(temporary, stat.S_IMODE(info.st_mode))
        if pathlib.Path(raw_path).expanduser().resolve(strict=True) != path or digest(path.read_bytes()) != req["expected_sha256"]:
            raise ValueError("config changed during write; rerun before writing")
        os.replace(temporary, str(path))
        temporary = None
        if path.read_bytes() != updated:
            raise ValueError("read-back verification failed")
    except Exception as exc:
        raise RuntimeError(str(exc) + "; backup: " + str(backup)) from None
    finally:
        if temporary is not None:
            os.unlink(temporary)
    return {"path": str(path), "status": "updated", "backup": str(backup), "sha256": digest(updated)}

try:
    print(json.dumps(run(json.load(sys.stdin))))
except Exception as exc:
    print(json.dumps({"error": str(exc)}))
    sys.exit(1)
'''

KEY = r'''(?:[A-Za-z0-9_-]+|"(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*')'''
ASSIGNMENT = re.compile(
    rf'''(?m)^(?P<prefix>[ \t]*(?:{KEY}[ \t]*\.[ \t]*)*(?:model|"model"|'model')[ \t]*=[ \t]*)'''
    r'''(?P<value>"(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*')(?P<tail>[ \t]*(?:\#[^\r\n]*)?)(?=\r?$)'''
)
MODEL = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/+\-]*\Z")
DEFAULT_TARGETS = Path(__file__).resolve().parent.parent / ".runtime/codex-model-targets.json"


def model_at(config, keys):
    for key in keys:
        config = config[key]
    return config


def patch_config(raw, model, all_profiles=False):
    """Keep formatting and reject any edit that changes unrelated TOML values."""
    bom = b"\xef\xbb\xbf" if raw.startswith(b"\xef\xbb\xbf") else b""
    text = raw.decode("utf-8-sig")
    parsed = tomllib.loads(text)
    profiles = parsed.get("profiles", {})
    active = parsed.get("profile")
    if not isinstance(profiles, dict):
        raise ValueError("profiles must be a TOML table")
    if active is not None and (not isinstance(active, str) or active not in profiles):
        raise ValueError("selected profile does not exist in this config")
    keys_to_update = [("model",)]
    for name, profile in profiles.items():
        if not isinstance(profile, dict):
            raise ValueError("profile must be a TOML table")
        if "model" in profile and (all_profiles or name == active):
            keys_to_update.append(("profiles", name, "model"))
    changes = []
    for keys in keys_to_update:
        parent = model_at(parsed, keys[:-1])
        old = parent.get("model")
        if "model" in parent and not isinstance(old, str):
            raise ValueError("model must be a string")
        if old == model:
            continue
        expected = copy.deepcopy(parsed)
        model_at(expected, keys[:-1])["model"] = model
        if "model" not in parent:
            newline = "\r\n" if "\r\n" in text else "\n"
            candidate = "model = " + json.dumps(model) + newline + text
        else:
            # Semantic comparison disambiguates root/profile/provider assignments,
            # quoted/dotted keys and fake assignments inside multiline strings.
            candidate = None
            for match in ASSIGNMENT.finditer(text):
                amended = text[:match.start("value")] + json.dumps(model) + text[match.end("value"):]
                try:
                    if tomllib.loads(amended) == expected:
                        candidate = amended
                        break
                except tomllib.TOMLDecodeError:
                    continue
            if candidate is None:
                raise ValueError("cannot safely edit " + ".".join(keys) + "; use a single-line model assignment instead of an inline table/multiline value")
        if tomllib.loads(candidate) != expected:
            raise ValueError("refusing an edit that changes unrelated configuration")
        text, parsed = candidate, expected
        changes.append((".".join(keys), old, model))
    overrides = [(name, profile["model"]) for name, profile in parsed.get("profiles", {}).items()
                 if "model" in profile and profile["model"] != model]
    return bom + text.encode("utf-8"), changes, overrides


def load_targets(path, selected):
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or set(data) != {"targets"} or not isinstance(data["targets"], list) or not data["targets"]:
        raise ValueError('inventory must contain a nonempty "targets" array')
    names = set()
    for target in data["targets"]:
        if not isinstance(target, dict) or set(target) - {"name", "path", "ssh", "python"}:
            raise ValueError("unknown target fields; allowed: name, path, ssh, python")
        name = target.get("name", "")
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", name) or name in names:
            raise ValueError("target names must be unique letters, digits, underscores or hyphens")
        names.add(name)
        for key in ("path", "ssh", "python"):
            if key in target and (not isinstance(target[key], str) or not target[key] or any(ord(c) < 32 for c in target[key])):
                raise ValueError(name + ": invalid " + key)
        if "path" in target and not target["path"].startswith(("/", "~/")):
            raise ValueError(name + ": path must be absolute or start with ~/")
        if "ssh" in target and not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.@:\[\]-]*", target["ssh"]):
            raise ValueError(name + ": invalid SSH destination")
        if "python" in target and "ssh" not in target:
            raise ValueError(name + ": python is only supported for SSH targets")
    if set(selected) - names:
        raise ValueError("unknown targets: " + ", ".join(sorted(set(selected) - names)))
    return [target for target in data["targets"] if not selected or target["name"] in selected]


def exchange(target, request, timeout, ssh_config):
    if "ssh" in target:
        command = ["ssh", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
                   "-o", "ConnectTimeout=5", "-o", "ConnectionAttempts=1",
                   "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=2"]
        if ssh_config is not None:
            command += ["-F", str(ssh_config.expanduser().resolve())]
        command += [target["ssh"], shlex.join([target.get("python", "python3"), "-c", FILE_HELPER])]
    else:
        command = [sys.executable, "-c", FILE_HELPER]
    result = subprocess.run(command, input=json.dumps({**request, "path": target.get("path")}),
                            text=True, capture_output=True, timeout=timeout)
    try:
        response = json.loads(result.stdout)
    except (ValueError, TypeError):
        # Do not print stdout: it can contain configuration and credentials.
        raise RuntimeError("transport failed (exit " + str(result.returncode) + "): " + result.stderr.strip()[:400]) from None
    if not isinstance(response, dict) or result.returncode or "error" in response:
        raise RuntimeError(response.get("error", "transport failed") if isinstance(response, dict) else "invalid transport response")
    return response


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("model", help="exact model ID, e.g. gpt-6.2-astra")
    parser.add_argument("--targets", type=Path, default=DEFAULT_TARGETS, help="JSON inventory (default: repository .runtime/codex-model-targets.json)")
    parser.add_argument("--only", action="append", default=[], metavar="NAME", help="select a target; repeatable")
    parser.add_argument("--apply", action="store_true", help="back up, write and verify; otherwise preview only")
    parser.add_argument("--all-profiles", action="store_true", help="also change model overrides in inactive named profiles")
    parser.add_argument("--ssh-config", type=Path, help="optional SSH config, passed to ssh -F")
    parser.add_argument("--timeout", type=int, default=20, help="seconds per local/SSH operation (default: 20)")
    args = parser.parse_args(argv)
    if not MODEL.fullmatch(args.model):
        parser.error("invalid model ID")
    if args.timeout < 1:
        parser.error("timeout must be positive")
    try:
        targets = load_targets(args.targets, args.only)
    except (OSError, ValueError) as exc:
        parser.error(str(exc))
    print(("APPLY" if args.apply else "PREVIEW") + " model=" + args.model, flush=True)
    prepared, failures, unchanged, updated = [], 0, 0, 0
    for target in targets:
        name = target["name"]
        try:
            snapshot = exchange(target, {"op": "read"}, args.timeout, args.ssh_config)
            raw = base64.b64decode(snapshot["content"], validate=True)
            patched, changes, overrides = patch_config(raw, args.model, args.all_profiles)
            print("[" + name + "] " + snapshot["path"], flush=True)
            for key, old, new in changes:
                print("  " + key + ": " + json.dumps(old) + " -> " + json.dumps(new), flush=True)
            for profile, model in overrides:
                print("  retained profile override: " + json.dumps(profile) + " = " + json.dumps(model), flush=True)
            if changes:
                prepared.append((target, snapshot, patched))
            else:
                unchanged += 1
                print("  unchanged", flush=True)
        except (OSError, ValueError, RuntimeError, KeyError, subprocess.TimeoutExpired) as exc:
            failures += 1
            message = "operation timed out" if isinstance(exc, subprocess.TimeoutExpired) else str(exc)
            print("[" + name + "] FAILED: " + message, flush=True)
    if args.apply:
        for target, snapshot, patched in prepared:
            try:
                result = exchange(target, {"op": "write", "expected_path": snapshot["path"],
                    "expected_sha256": snapshot["sha256"], "content": base64.b64encode(patched).decode("ascii")},
                    args.timeout, args.ssh_config)
                print("[" + target["name"] + "] verified; backup: " + result["backup"], flush=True)
                updated += 1
            except (OSError, ValueError, RuntimeError, KeyError, subprocess.TimeoutExpired) as exc:
                failures += 1
                message = "write timed out; state uncertain, rerun preview" if isinstance(exc, subprocess.TimeoutExpired) else str(exc)
                print("[" + target["name"] + "] FAILED: " + message, flush=True)
    print(f"Summary: targets={len(targets)} unchanged={unchanged} " +
          (f"updated={updated}" if args.apply else f"would_update={len(prepared)}") + f" failed={failures}", flush=True)
    print("Config files only. Existing sessions and running clients may retain their selected model.", flush=True)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
