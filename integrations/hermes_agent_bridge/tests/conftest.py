from __future__ import annotations

import os
from pathlib import Path
import sys


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
if str(REPOSITORY_ROOT) not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT))

# Integration tests defer-import Hermes internals (hermes_cli, tools) that live
# inside the Hermes installation rather than this repository.  Resolve the
# Hermes source tree from HERMES_HOME (set by the dispatcher) or the default
# ~/.hermes/hermes-agent, and add it to sys.path so deferred imports resolve.
_hermes_home = Path(os.environ.get("HERMES_HOME", str(Path.home() / ".hermes")))
_hermes_src = _hermes_home / "hermes-agent"
if _hermes_src.is_dir() and str(_hermes_src) not in sys.path:
    sys.path.insert(0, str(_hermes_src))
