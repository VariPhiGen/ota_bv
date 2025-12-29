"""
OTA dispatcher for sending commands to connected devices.

Responsibilities:
- Generate command_id per OTA dispatch.
- Persist commands in `ota_commands.json`.
- Dispatch only to online/connected devices.
- Track per-device state: pending, sent, acked, failed.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Tuple

from app.websocket_manager import manager
from app.minio_client import get_json, put_json
from app.device_registry import _load_devices_list  # type: ignore

OTA_LOGS_KEY = "ota_logs.json"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _load_commands() -> List[Dict[str, Any]]:
    data = get_json(OTA_LOGS_KEY, default=[])
    if isinstance(data, dict):
        return list(data.values())
    if isinstance(data, list):
        return data
    return []


def _save_commands(data: List[Dict[str, Any]]) -> None:
    put_json(OTA_LOGS_KEY, data)


def _device_is_online(sensor_id: str) -> bool:
    devices = _load_devices_list()
    for d in devices:
        if d.get("sensor_id") == sensor_id or d.get("device_id") == sensor_id:
            return bool(d.get("online"))
    return False


def _extract_targets(command: Dict[str, Any]) -> Tuple[List[str], Dict[str, Any]]:
    """
    Determine target device_ids for this command.
    Supports either:
      - command["targets"]["device_ids"] = [...]
      - command["sensor_id"] = "sensor-001" (legacy single-target)
    Returns (device_ids, targets_obj).
    """
    targets = command.get("targets") or {}
    device_ids = targets.get("device_ids") if isinstance(targets, dict) else None
    if isinstance(device_ids, list) and device_ids:
        return [str(x) for x in device_ids if str(x).strip()], {"device_ids": [str(x) for x in device_ids if str(x).strip()]}

    sensor_id = command.get("sensor_id")
    if sensor_id:
        sid = str(sensor_id)
        return [sid], {"device_ids": [sid]}

    return [], {"device_ids": []}


async def send_ota_command(command: Dict[str, Any]) -> Dict[str, Any]:
    """
    Dispatch an OTA command to one or more devices.

    The command payload must include either:
      - targets.device_ids (list[str])
      - sensor_id (str) [legacy single-target]
    """
    device_ids, targets_obj = _extract_targets(command)
    if not device_ids:
        raise ValueError("targets.device_ids (or sensor_id) is required to send OTA command")

    command_id = command.get("command_id") or str(uuid.uuid4())
    now = _now()

    entry: Dict[str, Any] = {
        "command_id": command_id,
        "command": command.get("command") or command.get("action"),
        "targets": targets_obj,
        "status": "pending",  # overall status
        "created_at": now,
        "last_update": now,
        "payload": {k: v for k, v in command.items() if k != "sensor_id"},
        "per_device": {sid: {"status": "pending"} for sid in device_ids},
        "acks": [],
    }

    commands = _load_commands()

    commands.append(entry)
    _save_commands(commands)

    # Fan-out send to each device_id; all share the same command_id for correlation.
    any_sent = False
    any_failed = False
    for sid in device_ids:
        websocket = manager.get(sid)
        if not websocket or not _device_is_online(sid):
            entry["per_device"][sid] = {"status": "failed", "reason": "device_offline", "last_update": _now()}
            any_failed = True
            continue

        to_send = dict(command)
        to_send["command_id"] = command_id
        to_send["sensor_id"] = sid  # helpful for devices that key off sensor_id
        sent = await manager.send_command(sid, to_send)
        if sent:
            entry["per_device"][sid] = {"status": "sent", "last_update": _now()}
            any_sent = True
        else:
            entry["per_device"][sid] = {"status": "failed", "reason": "send_failed", "last_update": _now()}
            any_failed = True

    if any_sent and any_failed:
        entry["status"] = "partial"
    elif any_sent:
        entry["status"] = "sent"
    else:
        entry["status"] = "failed"
        entry["reason"] = "all_targets_failed"

    entry["last_update"] = _now()

    # update entry in list
    for idx, c in enumerate(commands):
        if c["command_id"] == command_id:
            commands[idx] = entry
            break
    _save_commands(commands)
    return entry


def mark_command_acked(command_id: str, ack_payload: Dict[str, Any]) -> None:
    """Attach an ACK to a command_id and update per-device state."""
    if not command_id:
        return
    commands = _load_commands()
    for idx, entry in enumerate(commands):
        if entry.get("command_id") == command_id:
            updated = dict(entry)
            ack_sensor = ack_payload.get("sensor_id")
            per_device = dict(updated.get("per_device") or {})
            if ack_sensor:
                prev = dict(per_device.get(ack_sensor) or {})
                per_device[ack_sensor] = {**prev, "status": "acked", "ack": ack_payload, "last_update": _now()}
            updated["per_device"] = per_device

            acks = list(updated.get("acks") or [])
            acks.append(ack_payload)
            updated["acks"] = acks
            # Keep backward-compat "ack" as latest ack (UI may use it)
            updated["ack"] = ack_payload

            # Overall status: acked when all targets have acked; otherwise keep sent/partial.
            targets = (updated.get("targets") or {}).get("device_ids") or []
            if targets and all((per_device.get(sid) or {}).get("status") == "acked" for sid in targets):
                updated["status"] = "acked"
            updated["last_update"] = _now()
            commands[idx] = updated
            _save_commands(commands)
            return


def mark_latest_command_acked(sensor_id: str, ack_payload: Dict[str, Any]) -> str | None:
    """
    Best-effort ACK correlation when the edge does not provide command_id.
    Marks the latest sent/pending command for this sensor_id as acked and attaches ack_payload.
    Returns the matched command_id if found.
    """
    if not sensor_id:
        return None

    commands = _load_commands()

    def _ts(entry: Dict[str, Any]) -> str:
        # ISO-8601 strings sort lexicographically when consistently formatted.
        return str(entry.get("last_update") or entry.get("created_at") or "")

    candidates = []
    for i, c in enumerate(commands):
        targets = (c.get("targets") or {}).get("device_ids") or []
        if sensor_id in targets and c.get("status") in ("sent", "pending", "partial"):
            candidates.append((i, c))
    if not candidates:
        return None

    idx, entry = sorted(candidates, key=lambda t: _ts(t[1]))[-1]
    command_id = entry.get("command_id")
    if command_id:
        mark_command_acked(command_id, ack_payload)
        return command_id
    return None

