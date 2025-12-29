# OTA Central Server (FastAPI) + Admin UI (React) + MinIO

This repo contains:
- **Central server**: FastAPI app that manages devices, sends OTA commands over WebSocket, stores state in MinIO.
- **Admin UI**: React (Vite + Ant Design) frontend to manage devices, uploads, OTA history, and configuration fetch.
- **MinIO**: S3-compatible storage for models/configs + JSON “indexes” used by the server.

---

## Quick start (Docker Compose)

From the `central_server/` directory:

```bash
docker compose up --build
```

Services / ports:
- **API**: `http://localhost:8000`
- **UI**: `http://localhost:3000`
- **MinIO S3**: `http://localhost:9000`
- **MinIO Console**: `http://localhost:9001`

---

## Login

The API uses HTTP Basic auth.

**Default credentials (hardcoded in `central_server/app/auth.py`):**
- **username**: `admin`
- **password**: `FUCKOFF'

> Security note: This is fine for local/testing, but you should change this before any shared deployment.

---

## Environment variables

### MinIO (required by backend)
Set these in `central_server/.env` (loaded by docker-compose). Note: `.env` is typically git-ignored.

- **`MINIO_ENDPOINT`**: MinIO endpoint **reachable from the API container**  
  - Docker compose: `http://minio:9000`
- **`MINIO_PUBLIC_ENDPOINT`**: MinIO endpoint **reachable from browsers / edge devices**  
  - Local testing: `http://localhost:9000`
  - On a LAN for devices: `http://<SERVER_LAN_IP>:9000`
- **`MINIO_ACCESS_KEY`**, **`MINIO_SECRET_KEY`**
- **`MINIO_BUCKET`** (optional, default: `ota-bucket`)

Why `MINIO_PUBLIC_ENDPOINT` matters:
- Direct object URLs may be **403** (private bucket). The server also returns **pre-signed download URLs** for devices.
- Docker hostname `minio` will not resolve from a browser/device; use a public host/IP.

### CORS (backend)
- **`ALLOWED_ORIGINS`** (optional, default includes `http://localhost:3000,http://localhost:5173`)

### Frontend build args (Docker)
Configured in `central_server/docker-compose.yml`:
- **`VITE_API_BASE`** (default `http://localhost:8000`)
- **`VITE_WS_URL`** (default `ws://localhost:8000/ws`)

---

## Key features

### Uploads
- **Upload Model**: upload `.hef` + `labels.json`
- **Upload Config**: upload a config JSON
- **Delete Model / Config**: deletes objects from MinIO and removes the index entry

Relevant endpoints:
- `POST /upload-model`
- `POST /upload-config`
- `GET /list-uploads`
- `POST /delete-model`
- `POST /delete-config`

### OTA commands + ACK correlation (single `command_id`)
- UI sends **one** `POST /send-command` with `targets.device_ids`.
- Backend fans out to devices over WebSocket under the **same `command_id`**.
- Devices send `type:"ack"` with the same `command_id`.
- UI shows a **unified history row** with per-device ACK state.

Relevant endpoints:
- `POST /send-command`
- `GET /ota-history`
- `GET /ota-status/{command_id}`

### Get Configuration (per device)
From Devices page:
- **Get Configuration** sends `command:"get_configuration"` with a generated `command_id`
- Device replies with `type:"config"` and the same `command_id`
- Server persists **latest configuration** per device and broadcasts it to the UI
- UI shows **Latest Config** and opens **Show Configuration** popup

---

## WebSocket protocol (high level)

Server WS URL:
- `ws://<API_HOST>:8000/ws`

Typical messages:
- Device → server: `{"type":"register","sensor_id":"sensor-001"}`
- Server → device: `{"type":"ota_command","command":"ota_update","command_id":"...","targets":{"device_ids":[...]}, ...}`
- Device → server: `{"type":"ack","sensor_id":"sensor-001","command_id":"...","payload":{...}}`
- Device → server: `{"type":"config","sensor_id":"sensor-001","command_id":"...","payload":{"status":"success","config":{...},"time":"..."}}`

---

## Troubleshooting

### “No Network request” in Upload pages
This usually means the page crashed before `fetch()` ran. Check browser console for React errors.

### MinIO download URL returns 403
Use the server-provided **pre-signed** URLs (returned by `/list-uploads`). Also ensure `MINIO_PUBLIC_ENDPOINT` is set correctly.

### Devices UI “Get Configuration” loader never stops
The loader stops when a `type:"config"` WS message is received for that device; there is also a 30s timeout fallback.
If it still spins, verify the edge is actually sending the config response and that `sensor_id` matches the device row.


