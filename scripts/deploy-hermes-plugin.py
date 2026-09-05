#!/usr/bin/env python3
"""Install the local Hermes plugin and configure its shared worker API secret."""

from __future__ import annotations

import os
import argparse
from pathlib import Path
import secrets
import tempfile


REPOSITORY = Path(__file__).resolve().parent.parent
CONTROL_ENV = REPOSITORY / ".env"
PLUGIN_SOURCE = REPOSITORY / "integrations" / "hermes_agent_bridge"


def read_dotenv(path: Path) -> tuple[list[str], dict[str, str]]:
    lines = path.read_text(encoding="utf-8").splitlines()
    values: dict[str, str] = {}
    for line in lines:
        if not line or line.lstrip().startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value
    return lines, values


def update_dotenv(path: Path, updates: dict[str, str]) -> None:
    lines, _ = read_dotenv(path)
    remaining = dict(updates)
    rendered: list[str] = []
    for line in lines:
        if line and not line.lstrip().startswith("#") and "=" in line:
            key = line.split("=", 1)[0].strip()
            if key in remaining:
                rendered.append(f"{key}={remaining.pop(key)}")
                continue
        rendered.append(line)
    if remaining:
        if rendered and rendered[-1]:
            rendered.append("")
        rendered.extend(f"{key}={value}" for key, value in remaining.items())
    mode = path.stat().st_mode & 0o777
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write("\n".join(rendered) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def install_link(plugin_link: Path) -> None:
    plugin_link.parent.mkdir(parents=True, exist_ok=True)
    if plugin_link.is_symlink() and plugin_link.resolve() == PLUGIN_SOURCE.resolve():
        return
    if plugin_link.exists() or plugin_link.is_symlink():
        raise RuntimeError(f"refusing to replace existing plugin path: {plugin_link}")
    plugin_link.symlink_to(PLUGIN_SOURCE, target_is_directory=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--hermes-home", type=Path, default=Path.home() / ".hermes")
    parser.add_argument(
        "--disable-control-matrix",
        action="store_true",
        help="Disable the legacy Agent Bridge Matrix UI after Hermes owns approvals.",
    )
    args = parser.parse_args()
    hermes_home = args.hermes_home.expanduser().resolve()
    _, control = read_dotenv(CONTROL_ENV)
    token = control.get("WORKER_API_TOKEN", "").strip() or secrets.token_hex(32)
    control_updates = {
        "WORKER_API_ENABLED": "true",
        "WORKER_API_TOKEN": token,
    }
    if args.disable_control_matrix:
        control_updates["MATRIX_ENABLED"] = "false"
    update_dotenv(CONTROL_ENV, control_updates)
    update_dotenv(hermes_home / ".env", {"AGENT_BRIDGE_WORKER_API_TOKEN": token})
    install_link(hermes_home / "plugins" / "agent-bridge-worker")
    print("Configured Worker API and installed agent-bridge-worker (secret not shown).")


if __name__ == "__main__":
    main()
