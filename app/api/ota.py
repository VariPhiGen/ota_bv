from __future__ import annotations

from typing import Any, Dict, List

from fastapi import APIRouter, HTTPException, Depends
from app.auth import get_admin

from app.ota_dispatcher import send_ota_command, _load_commands  # type: ignore

router = APIRouter(prefix="", tags=["ota"])


@router.post("/send-command", response_model=Dict[str, Any])
async def send_ota(payload: Dict[str, Any], auth: bool = Depends(get_admin)) -> Dict[str, Any]:
    """
    Send an OTA command. Supports either:
      - targets.device_ids (preferred): a single command_id fan-out to multiple devices
      - sensor_id (legacy): single-device target
    """
    try:
        return await send_ota_command(payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/ota-history", response_model=List[Dict[str, Any]])
async def ota_history(auth: bool = Depends(get_admin)) -> List[Dict[str, Any]]:
    """Return all OTA commands from MinIO."""
    commands = _load_commands()
    return commands


@router.get("/ota-status/{command_id}", response_model=Dict[str, Any])
async def ota_status(command_id: str, auth: bool = Depends(get_admin)) -> Dict[str, Any]:
    """Return status for a specific OTA command_id."""
    commands = _load_commands()
    for c in commands:
        if c.get("command_id") == command_id:
            return c
    raise HTTPException(status_code=404, detail="Command not found")

