"""
In-memory WebSocket connection manager keyed by sensor_id.
"""

from __future__ import annotations

from typing import Dict, Optional, Set, Any

from fastapi import WebSocket


class WebSocketManager:
    def __init__(self) -> None:
        self.active_connections: Dict[str, WebSocket] = {}

    async def connect(self, sensor_id: str, websocket: WebSocket) -> None:
        """Store the WebSocket connection for the sensor."""
        self.active_connections[sensor_id] = websocket

    def disconnect(self, sensor_id: str) -> None:
        """Remove a WebSocket connection if present."""
        self.active_connections.pop(sensor_id, None)

    def get(self, sensor_id: str) -> Optional[WebSocket]:
        return self.active_connections.get(sensor_id)

    async def send_command(self, sensor_id: str, command: dict) -> bool:
        """
        Send an OTA command to a connected device.
        Returns True if the device was connected and the message sent.
        """
        websocket = self.get(sensor_id)
        if websocket is None:
            return False

        payload = {"type": "ota_command", **command}
        await websocket.send_json(payload)
        return True

    async def broadcast(self, message: Dict[str, Any], exclude: Set[str] | None = None) -> None:
        """
        Broadcast a JSON message to all connected websockets.
        Best-effort: failures on one connection won't stop others.
        """
        exclude = exclude or set()
        for sid, ws in list(self.active_connections.items()):
            if sid in exclude:
                continue
            try:
                await ws.send_json(message)
            except Exception:
                # Ignore send failures; connection cleanup will happen on disconnect.
                continue


# Shared manager instance for use across modules.
manager = WebSocketManager()

