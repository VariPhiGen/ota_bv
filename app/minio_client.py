from __future__ import annotations

import json
import os
from urllib.parse import urlparse
from typing import Any, BinaryIO

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

MINIO_ENDPOINT = os.getenv("MINIO_ENDPOINT")
MINIO_PUBLIC_ENDPOINT = os.getenv("MINIO_PUBLIC_ENDPOINT")  # optional: browser-reachable endpoint for returned URLs
MINIO_ACCESS_KEY = os.getenv("MINIO_ACCESS_KEY")
MINIO_SECRET_KEY = os.getenv("MINIO_SECRET_KEY")
MINIO_BUCKET = os.getenv("MINIO_BUCKET", "ota-bucket")
MINIO_REGION = os.getenv("MINIO_REGION", "us-east-1")


def _client(endpoint_url: str | None = None):
    if not MINIO_ENDPOINT or not MINIO_ACCESS_KEY or not MINIO_SECRET_KEY:
        raise RuntimeError("MinIO configuration missing: set MINIO_ENDPOINT, MINIO_ACCESS_KEY, MINIO_SECRET_KEY")
    # Force SigV4 + path-style addressing for MinIO compatibility and stable presigned URLs.
    cfg = Config(signature_version="s3v4", s3={"addressing_style": "path"})
    return boto3.client(
        "s3",
        endpoint_url=endpoint_url or MINIO_ENDPOINT,
        region_name=MINIO_REGION,
        aws_access_key_id=MINIO_ACCESS_KEY,
        aws_secret_access_key=MINIO_SECRET_KEY,
        config=cfg,
    )


def ensure_bucket() -> None:
    s3 = _client()
    try:
        s3.head_bucket(Bucket=MINIO_BUCKET)
    except ClientError:
        s3.create_bucket(Bucket=MINIO_BUCKET)


def put_json(key: str, data: Any) -> None:
    ensure_bucket()
    body = json.dumps(data, indent=2).encode("utf-8")
    _client().put_object(Bucket=MINIO_BUCKET, Key=key, Body=body, ContentType="application/json")


def get_json(key: str, default: Any = None) -> Any:
    ensure_bucket()
    try:
        resp = _client().get_object(Bucket=MINIO_BUCKET, Key=key)
    except ClientError as e:
        if e.response["Error"]["Code"] in ("NoSuchKey", "404"):
            return default
        raise
    body = resp["Body"].read()
    if not body:
        return default
    try:
        return json.loads(body)
    except json.JSONDecodeError:
        return default


def upload_fileobj(fobj: BinaryIO, key: str, content_type: str | None = None) -> str:
    ensure_bucket()
    extra = {"ContentType": content_type} if content_type else {}
    _client().upload_fileobj(fobj, MINIO_BUCKET, key, ExtraArgs=extra or None)
    return object_url(key)


def upload_bytes(data: bytes, key: str, content_type: str | None = None) -> str:
    ensure_bucket()
    extra = {"ContentType": content_type} if content_type else {}
    _client().put_object(Bucket=MINIO_BUCKET, Key=key, Body=data, **extra)
    return object_url(key)


def _normalize_endpoint(endpoint: str) -> str:
    """
    Ensure endpoint is a usable absolute URL (e.g. add http:// if user provided 'localhost:9000').
    """
    ep = endpoint.strip().rstrip("/")
    parsed = urlparse(ep)
    if not parsed.scheme:
        ep = f"http://{ep}"
    return ep.rstrip("/")


def object_url(key: str) -> str:
    endpoint = MINIO_PUBLIC_ENDPOINT or MINIO_ENDPOINT
    if endpoint:
        endpoint = _normalize_endpoint(endpoint)
        return f"{endpoint}/{MINIO_BUCKET}/{key}"
    return f"s3://{MINIO_BUCKET}/{key}"


def presign_get_url(key: str, expires_seconds: int = 3600) -> str:
    """
    Generate a pre-signed GET URL for an object.

    This is the safest way to let devices download artifacts without making the bucket public.
    The host embedded in the URL uses MINIO_PUBLIC_ENDPOINT when set (otherwise MINIO_ENDPOINT).
    """
    endpoint = MINIO_PUBLIC_ENDPOINT or MINIO_ENDPOINT
    if endpoint:
        endpoint = _normalize_endpoint(endpoint)
    s3 = _client(endpoint_url=endpoint) if endpoint else _client()
    return s3.generate_presigned_url(
        "get_object",
        Params={"Bucket": MINIO_BUCKET, "Key": key},
        ExpiresIn=max(1, int(expires_seconds)),
        HttpMethod="GET",
    )


def delete_object(key: str) -> None:
    ensure_bucket()
    _client().delete_object(Bucket=MINIO_BUCKET, Key=key)


def list_objects(prefix: str) -> list[dict[str, str]]:
    ensure_bucket()
    resp = _client().list_objects_v2(Bucket=MINIO_BUCKET, Prefix=prefix)
    contents = resp.get("Contents", []) or []
    results = []
    for obj in contents:
        key = obj["Key"]
        size = obj.get("Size", 0)
        url = object_url(key)
        results.append({"key": key, "size": size, "url": url})
    return results

