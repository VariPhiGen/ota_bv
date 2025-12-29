from __future__ import annotations

import os
from typing import Any, Dict
import base64
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Depends, HTTPException, status
from fastapi.security import HTTPBasicCredentials
from fastapi.middleware.cors import CORSMiddleware
from app.api.devices import router as devices_router, root_router as devices_root_router
from app.api.ota import router as ota_router
from app.api.upload import router as upload_router
from app.device_registry import mark_offline, mark_online, register_device, set_latest_configuration, set_latest_health
from app.websocket_manager import manager
from app.ota_dispatcher import mark_command_acked, mark_latest_command_acked
from app.auth import get_admin, security, ADMIN_PASS, ADMIN_USER
from app.minio_client import get_json, put_json

app = FastAPI(title="OTA Central Server")
origins = [
    o.strip()
    for o in os.getenv("ALLOWED_ORIGINS", "http://localhost:3000,http://localhost:5173").split(",")
    if o.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(devices_router)
app.include_router(devices_root_router)
app.include_router(ota_router)
app.include_router(upload_router)

@app.post("/login")
def login(credentials: HTTPBasicCredentials = Depends(security)) -> Dict[str, str]:
    # Validate credentials and return ok if correct
    if not get_admin(credentials):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Unauthorized",
            headers={"WWW-Authenticate": "Basic"},
        )
    token = base64.b64encode(f"{credentials.username}:{credentials.password}".encode()).decode()
    return {"status": "ok", "basic_token": token}

OTA_RESULTS_KEY = "ota_results.json"


def _now() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()


def _record_ack(sensor_id: str, ack_entry: Dict[str, Any]) -> None:
    """
    Persist ACKs in ota_results.json.

    Stored by command_id when available, otherwise by sensor_id.
    """
    results = get_json(OTA_RESULTS_KEY, default=[])
    if not isinstance(results, list):
        results = []
    results.append({"sensor_id": sensor_id, **ack_entry})
    put_json(OTA_RESULTS_KEY, results)


@app.post("/register-device")
def register_device_minio(payload: Dict[str, Any], auth: bool = Depends(get_admin)) -> Dict[str, Any]:
    """
    Register device with device_id, client_name, sensor_name (root endpoint for admin UI).
    """
    device_id = payload.get("device_id")
    if not device_id:
        raise HTTPException(status_code=400, detail="device_id is required")
    device = register_device(
        {
            "sensor_id": payload.get("sensor_name") or device_id,
            "device_id": device_id,
            "client_name": payload.get("client_name"),
            "sensor_name": payload.get("sensor_name"),
            "device_name": payload.get("sensor_name"),
        }
    )
    mark_offline(device.get("sensor_id") or device_id)
    return {"status": "success", "device": device}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    sensor_id: str | None = None
    await websocket.accept()

    try:
        while True:
            data = await websocket.receive_json()
            msg_type = data.get("type")

            if msg_type == "register":
                device = register_device(data)
                sensor_id = device["sensor_id"]
                await manager.connect(sensor_id, websocket)
                mark_online(sensor_id)
                # Broadcast device status to admin clients
                await manager.broadcast(
                    {"type": "device_status", "sensor_id": sensor_id, "online": True, "device": device, "timestamp": _now()},
                    exclude={sensor_id},
                )
                await websocket.send_json({"status": "registered", "sensor_id": sensor_id})

            elif msg_type == "ack":
                payload = data.get("payload") or {}
                ack_sensor = data.get("sensor_id") or payload.get("sensor_id") or sensor_id
                if not ack_sensor:
                    await websocket.send_json({"error": "sensor_id missing in ack"})
                    continue

                command_id = data.get("command_id") or payload.get("command_id")
                status = payload.get("status") or data.get("status") or "unknown"

                ack_entry = {
                    "command_id": command_id,
                    "sensor_id": ack_sensor,
                    "status": status,
                    "timestamp": _now(),
                    "payload": payload,
                }

                _record_ack(ack_sensor, ack_entry)
                if command_id:
                    mark_command_acked(command_id, ack_entry)
                else:
                    matched = mark_latest_command_acked(ack_sensor, ack_entry)
                    if matched:
                        ack_entry["command_id"] = matched
                mark_online(ack_sensor)
                # Push ACK event to admin clients (and any listeners) so UI updates without refresh.
                await manager.broadcast({"type": "ack", **ack_entry}, exclude={ack_sensor})
                await websocket.send_json({"status": "ack_received"})

            elif msg_type == "config":
                payload = data.get("payload") or {}
                cfg_sensor = data.get("sensor_id") or payload.get("sensor_id") or sensor_id
                if not cfg_sensor:
                    await websocket.send_json({"error": "sensor_id missing in config"})
                    continue

                command_id = data.get("command_id") or payload.get("command_id")
                status = payload.get("status") or data.get("status") or "unknown"
                cfg = payload.get("config")
                device_time = payload.get("time") or payload.get("timestamp")
                error = payload.get("error")

                updated = set_latest_configuration(
                    cfg_sensor,
                    command_id=command_id,
                    status=status,
                    config=cfg,
                    device_time=device_time,
                    received_at=_now(),
                    error=error,
                )
                mark_online(cfg_sensor)

                msg = {
                    "type": "config",
                    "sensor_id": cfg_sensor,
                    "command_id": command_id,
                    "timestamp": _now(),
                    "payload": payload,
                }
                # Broadcast to admin clients so Devices UI updates live.
                await manager.broadcast(msg, exclude={cfg_sensor})
                await websocket.send_json({"status": "config_received"})

            elif msg_type == "health":
                payload = data.get("payload") or {}
                health_sensor = data.get("sensor_id") or payload.get("sensor_id") or sensor_id
                if not health_sensor:
                    await websocket.send_json({"error": "sensor_id missing in health"})
                    continue

                command_id = data.get("command_id") or payload.get("command_id")
                status = payload.get("status") or data.get("status") or "unknown"
                device_time = payload.get("time") or payload.get("timestamp")
                error = payload.get("error")

                set_latest_health(
                    health_sensor,
                    command_id=command_id,
                    status=status,
                    health=payload,
                    device_time=device_time,
                    received_at=_now(),
                    error=error,
                )
                mark_online(health_sensor)

                msg = {
                    "type": "health",
                    "sensor_id": health_sensor,
                    "command_id": command_id,
                    "timestamp": _now(),
                    "payload": payload,
                }
                await manager.broadcast(msg, exclude={health_sensor})
                await websocket.send_json({"status": "health_received"})

            elif msg_type == "ping":
                if sensor_id:
                    mark_online(sensor_id)
                await websocket.send_json({"type": "pong"})

            else:
                await websocket.send_json({"error": "unknown_message_type"})

    except WebSocketDisconnect:
        if sensor_id:
            manager.disconnect(sensor_id)
            offline = mark_offline(sensor_id)
            # Broadcast offline status to admin clients
            await manager.broadcast(
                {"type": "device_status", "sensor_id": sensor_id, "online": False, "device": offline, "timestamp": _now()},
                exclude={sensor_id},
            )
    except Exception:
        # Ensure cleanup on unexpected exceptions
        if sensor_id:
            manager.disconnect(sensor_id)
            mark_offline(sensor_id)
        raise

