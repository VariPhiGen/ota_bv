from __future__ import annotations

import os
from typing import Any, Dict, List

from fastapi import APIRouter, HTTPException, Depends, Body
from app.auth import get_admin
from app.device_registry import register_device, mark_offline, _load_devices_list  # type: ignore
from app.minio_client import get_json, put_json

router = APIRouter(prefix="/devices", tags=["devices"])
root_router = APIRouter(tags=["devices"])

DEVICES_KEY = "devices.json"


def _list_devices_raw():
    return get_json(DEVICES_KEY, default=[])


def _list_devices() -> list:
    data = _list_devices_raw()
    if isinstance(data, dict):
        return list(data.values())
    if isinstance(data, list):
        return data
    return []


@router.get("", response_model=List[Dict[str, Any]])
@root_router.get("/devices", response_model=List[Dict[str, Any]])
async def list_devices(auth: bool = Depends(get_admin)) -> List[Dict[str, Any]]:
    """Return all registered devices."""
    return _list_devices()


@router.get("/get-devices", response_model=List[Dict[str, Any]])
@root_router.get("/get-devices", response_model=List[Dict[str, Any]])
async def list_devices_alias(auth: bool = Depends(get_admin)) -> List[Dict[str, Any]]:
    """Alias to return all registered devices."""
    return _list_devices()


@router.get("/{sensor_id}", response_model=Dict[str, Any])
async def get_device(sensor_id: str, auth: bool = Depends(get_admin)) -> Dict[str, Any]:
    """Return a single device by sensor_id."""
    devices = _list_devices()
    for d in devices:
        if d.get("sensor_id") == sensor_id or d.get("device_id") == sensor_id:
            return d
    raise HTTPException(status_code=404, detail="Device not found")


@router.post("/register", response_model=Dict[str, Any])
async def register(
    payload: Dict[str, Any] = Body(..., example={"sensor_id": "SENSOR_001", "client_name": "Client", "device_name": "Device"}),
    auth: bool = Depends(get_admin),
) -> Dict[str, Any]:
    """
    Register a device with sensor_id and optional client/device names.
    Marks it offline until it connects via WebSocket.
    """
    sensor_id = payload.get("sensor_id")
    if not sensor_id:
        raise HTTPException(status_code=400, detail="sensor_id is required")
    device = register_device(payload)
    mark_offline(sensor_id)
    return device


@router.post("/register-device", response_model=Dict[str, Any])
@root_router.post("/register-device", response_model=Dict[str, Any])
async def register_device_simple(
    payload: Dict[str, Any] = Body(
        ...,
        example={"device_id": "1234", "client_name": "ABC Corp", "sensor_name": "Sensor A"},
    ),
    auth: bool = Depends(get_admin),
) -> Dict[str, Any]:
    """
    Register/update a device by device_id with optional client_name and sensor_name.
    Stores entries as a list in devices.json for admin tracking.
    """
    device_id = payload.get("device_id")
    if not device_id:
        raise HTTPException(status_code=400, detail="device_id is required")

    sensor_id = payload.get("sensor_id") or payload.get("sensor_name") or device_id
    if not sensor_id:
        raise HTTPException(status_code=400, detail="sensor_id is required")

    client_name = payload.get("client_name", "")
    sensor_name = payload.get("sensor_name", "")

    devices = _list_devices_raw()
    if isinstance(devices, dict):
        devices = list(devices.values())
    if not isinstance(devices, list):
        devices = []

    found = False
    for d in devices:
        if d.get("device_id") == device_id or d.get("sensor_id") == sensor_id:
            d["client_name"] = client_name
            d["sensor_name"] = sensor_name
            d["sensor_id"] = sensor_id
            found = True
            break
    if not found:
        devices.append(
            {
                "sensor_id": sensor_id,
                "device_id": device_id,
                "client_name": client_name,
                "sensor_name": sensor_name,
            }
        )

    put_json(DEVICES_KEY, devices)
    return {"status": "success", "device_id": device_id}


@router.post("/update-device", response_model=Dict[str, Any])
@root_router.post("/update-device", response_model=Dict[str, Any])
async def update_device(
    payload: Dict[str, Any] = Body(
        ...,
        example={"sensor_id": "SENSOR_001", "client_name": "New Client", "device_name": "New Device"},
    ),
    auth: bool = Depends(get_admin),
) -> Dict[str, Any]:
    sensor_id = payload.get("sensor_id")
    if not sensor_id:
        raise HTTPException(status_code=400, detail="sensor_id is required")
    devices = _list_devices_raw()
    if isinstance(devices, dict):
        devices = list(devices.values())
    if not isinstance(devices, list):
        devices = []

    updated = None
    for d in devices:
        if d.get("sensor_id") == sensor_id:
            d["client_name"] = payload.get("client_name", d.get("client_name"))
            d["device_name"] = payload.get("device_name", d.get("device_name"))
            d["sensor_name"] = payload.get("sensor_name", d.get("sensor_name"))
            updated = d
            break
    if updated is None:
        raise HTTPException(status_code=404, detail="Device not found")

    put_json(DEVICES_KEY, devices)
    return {"status": "success", "device": updated}


@router.post("/delete-device", response_model=Dict[str, Any])
@root_router.post("/delete-device", response_model=Dict[str, Any])
async def delete_device(
    payload: Dict[str, Any] = Body(..., example={"sensor_id": "SENSOR_001"}),
    auth: bool = Depends(get_admin),
) -> Dict[str, Any]:
    sensor_id = payload.get("sensor_id")
    device_id = payload.get("device_id")
    if not sensor_id and not device_id:
        raise HTTPException(status_code=400, detail="sensor_id or device_id is required")

    devices = _list_devices_raw()
    if isinstance(devices, dict):
        devices = list(devices.values())
    if not isinstance(devices, list):
        devices = []

    new_list = [
        d
        for d in devices
        if not (d.get("sensor_id") == sensor_id or d.get("device_id") == device_id)
    ]
    if len(new_list) == len(devices):
        raise HTTPException(status_code=404, detail="Device not found")

    put_json(DEVICES_KEY, new_list)
    return {"status": "deleted", "sensor_id": sensor_id, "device_id": device_id}

