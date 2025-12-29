from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile, Depends, Body
from app.auth import get_admin
from app.minio_client import upload_fileobj, upload_bytes, list_objects, delete_object, get_json, put_json, object_url, presign_get_url

router = APIRouter(prefix="", tags=["upload"])


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _merge_nested(target: Dict[str, Any], path: List[str], value: Any) -> None:
    """Merge a dotted path into a nested dict."""
    node = target
    for part in path[:-1]:
        node = node.setdefault(part, {})
    node[path[-1]] = value


def _apply_updates(config_data: Dict[str, Any], updates: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Build nested_updates dict from updates and apply to config_data in-memory.
    Updates should be list of {"path": "a.b.c", "value": X}.
    """
    nested_updates: Dict[str, Any] = {}
    for item in updates:
        path_str = item.get("path")
        if not path_str:
            continue
        value = item.get("value")
        parts = path_str.split(".")
        _merge_nested(nested_updates, parts, value)

        node = config_data
        for part in parts[:-1]:
            if part not in node or not isinstance(node[part], dict):
                node[part] = {}
            node = node[part]
        node[parts[-1]] = value

    return nested_updates


@router.post("/upload-model", response_model=Dict[str, Any])
async def upload_model(
    hef_file: UploadFile = File(...),
    labels_file: UploadFile = File(...),
    model_name: str = Form(...),
    auth: bool = Depends(get_admin),
) -> Dict[str, Any]:
    """
    Upload a model package consisting of a .hef file and labels.json to MinIO.
    Requires unique model_name.
    """
    if not hef_file.filename or not hef_file.filename.lower().endswith(".hef"):
        raise HTTPException(status_code=400, detail="hef_file must have .hef extension")
    if not labels_file.filename or not labels_file.filename.lower().endswith(".json"):
        raise HTTPException(status_code=400, detail="labels_file must be a .json file")

    index = get_json("models/index.json", default=[]) or []
    if any(entry.get("name") == model_name for entry in index):
        raise HTTPException(status_code=400, detail="model_name already exists")

    model_id = uuid.uuid4().hex
    base_prefix = f"models/{model_name}"
    hef_key = f"{base_prefix}/model.hef"
    labels_key = f"{base_prefix}/labels.json"

    hef_url = upload_fileobj(hef_file.file, hef_key, content_type="application/octet-stream")
    labels_url = upload_fileobj(labels_file.file, labels_key, content_type="application/json")

    entry = {
        "id": model_id,
        "name": model_name,
        "created_at": _now(),
        "files": {
            "model": hef_key,
            "labels": labels_key,
            "model_url": hef_url,
            "labels_url": labels_url,
        },
    }
    index.append(entry)
    put_json("models/index.json", index)

    return {"model_id": model_id, "model_name": model_name, "hef_url": hef_url, "labels_url": labels_url}


@router.post("/upload-config", response_model=Dict[str, Any])
async def upload_config(
    config_file: UploadFile = File(...),
    updates: Optional[str] = Form(None),
    config_name: str = Form(...),
    auth: bool = Depends(get_admin),
) -> Dict[str, Any]:
    """
    Upload a configuration JSON to MinIO and optionally apply nested updates.
    Requires unique config_name.

    `updates` should be a JSON string of list items: [{"path": "a.b.c", "value": 1}, ...]
    """
    if not config_file.filename or not config_file.filename.lower().endswith(".json"):
        raise HTTPException(status_code=400, detail="config_file must be a .json file")

    content = await config_file.read()
    try:
        config_data = json.loads(content.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="Invalid JSON file") from exc

    index = get_json("configs/index.json", default=[]) or []
    if any(entry.get("name") == config_name for entry in index):
        raise HTTPException(status_code=400, detail="config_name already exists")

    parsed_updates: List[Dict[str, Any]] = []
    if updates:
        try:
            parsed_updates = json.loads(updates)
            if not isinstance(parsed_updates, list):
                raise ValueError("updates must be a JSON list")
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=400, detail=f"Invalid updates: {exc}") from exc

    nested_updates = _apply_updates(config_data, parsed_updates) if parsed_updates else {}

    config_id = uuid.uuid4().hex
    config_key = f"configs/{config_name}/configuration.json"

    config_url = upload_bytes(json.dumps(config_data, indent=2).encode("utf-8"), config_key, content_type="application/json")

    entry = {
        "id": config_id,
        "name": config_name,
        "created_at": _now(),
        "file": config_key,
        "file_url": config_url,
    }
    index.append(entry)
    put_json("configs/index.json", index)

    return {
        "config_id": config_id,
        "config_name": config_name,
        "config_url": config_url,
        "nested_updates": nested_updates,
        "applied_updates": parsed_updates,
        "effective_config": config_data,
    }


@router.get("/list-uploads", response_model=Dict[str, Any])
async def list_uploads(auth: bool = Depends(get_admin)) -> Dict[str, Any]:
    """List model and config objects in MinIO."""
    models_index = get_json("models/index.json", default=[]) or []
    configs_index = get_json("configs/index.json", default=[]) or []
    # Normalize/enrich URLs from stored object keys so the UI can always use full URLs
    # (important when MINIO_PUBLIC_ENDPOINT changes, or older entries were created with an internal endpoint).
    try:
        for m in models_index:
            files = m.get("files") or {}
            model_key = files.get("model")
            labels_key = files.get("labels")
            if model_key:
                files["model_url"] = object_url(model_key)
                files["model_download_url"] = presign_get_url(model_key)
            if labels_key:
                files["labels_url"] = object_url(labels_key)
                files["labels_download_url"] = presign_get_url(labels_key)
            m["files"] = files
        for c in configs_index:
            key = c.get("file")
            if key:
                c["file_url"] = object_url(key)
                c["file_download_url"] = presign_get_url(key)
    except Exception:
        # Never break listing due to URL enrichment errors.
        pass
    return {"models": models_index, "configs": configs_index}


@router.post("/delete-upload", response_model=Dict[str, Any])
async def delete_upload(
    payload: Dict[str, Any] = Body(..., example={"key": "models/abc123.hef"}),
    auth: bool = Depends(get_admin),
) -> Dict[str, Any]:
    key = payload.get("key")
    if not key:
        raise HTTPException(status_code=400, detail="key is required")
    delete_object(key)
    return {"status": "deleted", "key": key}


@router.post("/delete-model", response_model=Dict[str, Any])
async def delete_model(payload: Dict[str, Any] = Body(...), auth: bool = Depends(get_admin)) -> Dict[str, Any]:
    """
    Delete a model by name:
      - removes objects under models/{model_name}/ (model.hef, labels.json)
      - removes entry from models/index.json
    """
    model_name = (payload.get("model_name") or "").strip()
    if not model_name:
        raise HTTPException(status_code=400, detail="model_name is required")

    index = get_json("models/index.json", default=[]) or []
    kept = []
    deleted_entry: Dict[str, Any] | None = None
    for entry in index:
        if entry.get("name") == model_name:
            deleted_entry = entry
        else:
            kept.append(entry)
    if deleted_entry is None:
        raise HTTPException(status_code=404, detail="model_name not found")

    files = (deleted_entry.get("files") or {}) if isinstance(deleted_entry, dict) else {}
    # Prefer deleting the exact keys from index (works even if naming changes)
    keys_to_delete = [files.get("model"), files.get("labels")]
    # Fallback to standard keys
    keys_to_delete.extend([f"models/{model_name}/model.hef", f"models/{model_name}/labels.json"])
    for k in keys_to_delete:
        if not k:
            continue
        try:
            delete_object(k)
        except Exception:
            # Best-effort deletes; still remove from index to avoid stale UI.
            pass

    put_json("models/index.json", kept)
    return {"status": "deleted", "model_name": model_name}


@router.post("/delete-config", response_model=Dict[str, Any])
async def delete_config(payload: Dict[str, Any] = Body(...), auth: bool = Depends(get_admin)) -> Dict[str, Any]:
    """
    Delete a config by name:
      - removes object configs/{config_name}/configuration.json
      - removes entry from configs/index.json
    """
    config_name = (payload.get("config_name") or "").strip()
    if not config_name:
        raise HTTPException(status_code=400, detail="config_name is required")

    index = get_json("configs/index.json", default=[]) or []
    kept = []
    deleted_entry: Dict[str, Any] | None = None
    for entry in index:
        if entry.get("name") == config_name:
            deleted_entry = entry
        else:
            kept.append(entry)
    if deleted_entry is None:
        raise HTTPException(status_code=404, detail="config_name not found")

    key = None
    if isinstance(deleted_entry, dict):
        key = deleted_entry.get("file")
    keys_to_delete = [key, f"configs/{config_name}/configuration.json"]
    for k in keys_to_delete:
        if not k:
            continue
        try:
            delete_object(k)
        except Exception:
            pass

    put_json("configs/index.json", kept)
    return {"status": "deleted", "config_name": config_name}

