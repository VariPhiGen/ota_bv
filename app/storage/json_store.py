"""
Safe JSON persistence with basic file locking and atomic writes.

Designed for the central OTA server's registry files:
`devices.json`, `ota_commands.json`, and `ota_results.json`.
"""

from __future__ import annotations

import json
import os
import tempfile
from typing import Any, Dict

try:
    import fcntl
except ImportError:  # pragma: no cover - non-Unix platforms
    fcntl = None  # type: ignore


def _ensure_file(file_path: str) -> None:
    """Create parent directories and an empty JSON file if missing."""
    os.makedirs(os.path.dirname(file_path) or ".", exist_ok=True)
    if not os.path.exists(file_path):
        with open(file_path, "w", encoding="utf-8") as fh:
            fh.write("{}\n")


def _acquire_lock(fh, exclusive: bool) -> None:
    if fcntl is None:
        return
    mode = fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH
    fcntl.flock(fh.fileno(), mode)


def _release_lock(fh) -> None:
    if fcntl is None:
        return
    fcntl.flock(fh.fileno(), fcntl.LOCK_UN)


def read_json(file_path: str) -> Dict[str, Any]:
    """
    Read JSON content with a shared lock. Returns an empty dict on missing/empty/invalid files.
    """
    _ensure_file(file_path)
    with open(file_path, "r", encoding="utf-8") as fh:
        _acquire_lock(fh, exclusive=False)
        try:
            content = fh.read().strip()
            if not content:
                return {}
            try:
                return json.loads(content)
            except json.JSONDecodeError:
                return {}
        finally:
            _release_lock(fh)


def write_json(file_path: str, data: Dict[str, Any]) -> None:
    """
    Write JSON content with an exclusive lock using atomic replace to avoid partial writes.
    """
    _ensure_file(file_path)
    directory = os.path.dirname(file_path) or "."

    with open(file_path, "r+", encoding="utf-8") as fh:
        _acquire_lock(fh, exclusive=True)
        try:
            with tempfile.NamedTemporaryFile(
                "w", delete=False, dir=directory, encoding="utf-8"
            ) as tmp:
                json.dump(data or {}, tmp, indent=2, ensure_ascii=False)
                tmp.write("\n")
                tmp.flush()
                os.fsync(tmp.fileno())
                temp_name = tmp.name

            os.replace(temp_name, file_path)
        finally:
            _release_lock(fh)

