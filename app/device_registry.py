"""
Device registry backed by JSON storage.

Supports device registration and online/offline tracking using
`devices.json` with file-locking and atomic writes provided by json_store.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List

from app.minio_client import get_json, put_json

DEVICES_KEY = "devices.json"


def _now() -> str:
    """Return an ISO-8601 UTC timestamp with Z suffix."""
    return datetime.now(timezone.utc).isoformat()


def _load_devices_list() -> List[Dict[str, Any]]:
    data = get_json(DEVICES_KEY, default=[])
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        # convert dict keyed by sensor_id to list
        return list(data.values())
    return []


def _save_devices_list(devices: List[Dict[str, Any]]) -> None:
    put_json(DEVICES_KEY, devices)


def register_device(payload: Dict[str, Any]) -> Dict[str, Any]:
    """
    Register or update a device using the WebSocket payload.

    Expected payload keys:
      - sensor_id (str, required, unique key)
      - client_name (str)
      - device_name (str)
      - sensor_name (str)
    """
    sensor_id = payload.get("sensor_id")
    if not sensor_id:
        raise ValueError("sensor_id is required for registration")

    devices = _load_devices_list()
    now = _now()

    existing = None
    for d in devices:
        if d.get("sensor_id") == sensor_id or d.get("device_id") == payload.get("device_id"):
            existing = d
            break

    device_info: Dict[str, Any] = existing.copy() if existing else {}
    device_info["sensor_id"] = sensor_id
    if payload.get("device_id"):
        device_info["device_id"] = payload["device_id"]

    # Preserve existing names unless new non-empty values provided
    if payload.get("client_name") not in (None, ""):
        device_info["client_name"] = payload.get("client_name")
    if payload.get("device_name") not in (None, ""):
        device_info["device_name"] = payload.get("device_name")
    if payload.get("sensor_name") not in (None, ""):
        device_info["sensor_name"] = payload.get("sensor_name")

    # If names are still missing, fallback to previous or sensor_id
    device_info.setdefault("device_name", device_info.get("sensor_name") or sensor_id)
    device_info.setdefault("sensor_name", device_info.get("device_name") or sensor_id)

    device_info["online"] = True
    device_info["last_seen"] = now

    if existing:
        for i, d in enumerate(devices):
            if d is existing:
                devices[i] = device_info
                break
    else:
        devices.append(device_info)

    _save_devices_list(devices)
    return device_info


def mark_online(sensor_id: str) -> Dict[str, Any]:
    """Mark device online and refresh last_seen. Creates entry if missing."""
    if not sensor_id:
        raise ValueError("sensor_id is required")

    devices = _load_devices_list()
    now = _now()
    device_info = None
    for idx, d in enumerate(devices):
        if d.get("sensor_id") == sensor_id or d.get("device_id") == sensor_id:
            device_info = {**d, "online": True, "last_seen": now}
            devices[idx] = device_info
            break
    if device_info is None:
        device_info = {"sensor_id": sensor_id, "online": True, "last_seen": now}
        devices.append(device_info)
    _save_devices_list(devices)
    return device_info


def mark_offline(sensor_id: str) -> Dict[str, Any]:
    """Mark device offline and refresh last_seen. No-op if device missing."""
    if not sensor_id:
        raise ValueError("sensor_id is required")

    devices = _load_devices_list()
    for idx, d in enumerate(devices):
        if d.get("sensor_id") == sensor_id or d.get("device_id") == sensor_id:
            updated = {**d, "online": False, "last_seen": _now()}
            devices[idx] = updated
            _save_devices_list(devices)
            return updated
    return {}


def set_latest_configuration(
    sensor_id: str,
    *,
    command_id: str | None,
    status: str,
    config: Any | None,
    device_time: str | None = None,
    received_at: str | None = None,
    error: str | None = None,
) -> Dict[str, Any]:
    """
    Store latest configuration snapshot for a device.

    Saved under device["latest_configuration"] so the Devices UI can show the latest inline.
    """
    if not sensor_id:
        raise ValueError("sensor_id is required")

    devices = _load_devices_list()
    now = received_at or _now()
    updated_device: Dict[str, Any] | None = None

    latest = {
        "command_id": command_id,
        "status": status,
        "received_at": now,
        "device_time": device_time,
        "config": config,
        "error": error,
    }

    for idx, d in enumerate(devices):
        if d.get("sensor_id") == sensor_id or d.get("device_id") == sensor_id:
            updated_device = {**d, "latest_configuration": latest, "last_seen": _now()}
            devices[idx] = updated_device
            break

    if updated_device is None:
        updated_device = {"sensor_id": sensor_id, "online": True, "last_seen": _now(), "latest_configuration": latest}
        devices.append(updated_device)

    _save_devices_list(devices)
    return updated_device

