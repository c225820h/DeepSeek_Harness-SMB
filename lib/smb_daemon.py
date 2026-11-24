#!/usr/bin/env python3
"""Long-lived SMB worker for dsh-smb-picker.

Starting a Python process and running an NTLMv2 handshake for every grid cell
costs about 1.1 s per thumbnail on this Host. This daemon authenticates once,
then answers many requests on the same session, which brings a cold thumbnail
down to the decode itself (roughly 0.2–0.3 s) and a list to well under 100 ms.

Protocol — one line in, one response out, strictly serial:

    (startup, once)  {"host":…,"port":…,"username":…,"password":…,"share":…}
    (request)        {"id":1,"op":"list","path":"output"}
    (json result)    {"id":1,"ok":true,"json":{"entries":[…]}}\\n

    (request)        {"id":2,"op":"thumb","path":"output/a.png","width":400}
    (binary result)  {"id":2,"ok":true,"size":12345}\\n  followed by 12345 bytes

    (failure)        {"id":3,"ok":false,"code":"not_found","message":"…"}\\n

A failed request never kills the daemon: only a startup failure does. Streaming
an original file is deliberately NOT served here — that would block every other
request for the duration of a multi-megabyte transfer, so the Host opens a
one-shot `smb_worker.py` for it instead.
"""

from __future__ import annotations

import io
import json
import stat as stat_module
import sys

import PIL.Image
import PIL.ImageOps
import smbclient

from smb_common import MAX_THUMB_SOURCE_BYTES, classify, share_target

#: Largest thumbnail the daemon will decode, matching the HTTP route's clamp.
MAX_THUMB_WIDTH = 1024


def write_json(payload: dict) -> None:
    sys.stdout.buffer.write(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
    sys.stdout.buffer.write(b"\n")
    sys.stdout.buffer.flush()


def emit_error(request_id, code: str, message: str, status: str | None = None) -> None:
    payload = {"id": request_id, "ok": False, "code": code, "message": message}
    if status is not None:
        payload["status"] = status
    write_json(payload)


def render_thumb(target: str, width: int) -> bytes:
    """Decode one file off the share and downscale it to WebP."""
    info = smbclient.stat(target)
    if stat_module.S_ISDIR(info.st_mode):
        raise IsADirectoryError(target)
    if info.st_size > MAX_THUMB_SOURCE_BYTES:
        raise ValueError(f"file is {info.st_size} bytes, above the thumbnail ceiling")
    with smbclient.open_file(target, mode="rb") as handle:
        source = handle.read()
    image = PIL.Image.open(io.BytesIO(source))
    image = PIL.ImageOps.exif_transpose(image)
    image.thumbnail((width, width), PIL.Image.LANCZOS)
    if image.mode not in ("RGB", "RGBA"):
        image = image.convert("RGBA" if "A" in image.getbands() else "RGB")
    out = io.BytesIO()
    image.save(out, format="WEBP", quality=82, method=4)
    return out.getvalue()


def main() -> None:
    startup = sys.stdin.readline()
    if startup.strip() == "":
        emit_error(None, "bad_settings", "missing startup settings")
        raise SystemExit(1)
    try:
        settings = json.loads(startup)
    except Exception:
        emit_error(None, "bad_settings", "startup settings must be JSON")
        raise SystemExit(1)

    host = str(settings.get("host", "")).strip()
    share = str(settings.get("share", "")).strip()
    username = str(settings.get("username", "")).strip()
    if not host or not share or not username:
        emit_error(None, "bad_settings", "host, share and username are required")
        raise SystemExit(1)
    port = int(settings.get("port") or 445)

    try:
        smbclient.register_session(
            host,
            username=username,
            password=settings.get("password") or "",
            port=port,
            connection_timeout=settings.get("connectTimeout") or 10,
        )
    except Exception as error:  # noqa: BLE001 - classified below
        code, status = classify(error)
        emit_error(None, code, str(error), status)
        raise SystemExit(1)

    write_json({"id": 0, "ok": True, "json": {"ready": True}})

    for line in sys.stdin:
        if line.strip() == "":
            continue
        try:
            request = json.loads(line)
        except Exception:
            emit_error(None, "bad_request", "request must be JSON")
            continue

        request_id = request.get("id")
        op = request.get("op")
        path = str(request.get("path") or "")
        try:
            if op == "list":
                rows = []
                for entry in smbclient.scandir(share_target(host, share, path)):
                    info = entry.smb_info
                    rows.append({
                        "name": entry.name,
                        # FILE_ATTRIBUTE_DIRECTORY, read off the same QUERY_DIRECTORY
                        # response — `entry.is_dir()` can cost a second round trip on
                        # a reparse point, and a listing must not do that per entry.
                        "directory": bool(info.file_attributes & 0x10),
                        "size": info.end_of_file,
                        "mtime": int(info.last_write_time.timestamp()),
                    })
                write_json({"id": request_id, "ok": True, "json": {"entries": rows}})

            elif op == "stat":
                info = smbclient.stat(share_target(host, share, path))
                write_json({
                    "id": request_id,
                    "ok": True,
                    "json": {"size": info.st_size, "directory": stat_module.S_ISDIR(info.st_mode)},
                })

            elif op == "thumb":
                width = max(1, min(MAX_THUMB_WIDTH, int(request.get("width") or 400)))
                try:
                    payload = render_thumb(share_target(host, share, path), width)
                except IsADirectoryError:
                    emit_error(request_id, "wrong_type", "这是一个目录，不是文件")
                    continue
                except ValueError as error:
                    emit_error(request_id, "too_large", str(error))
                    continue
                write_json({"id": request_id, "ok": True, "size": len(payload)})
                sys.stdout.buffer.write(payload)
                sys.stdout.buffer.flush()

            else:
                emit_error(request_id, "bad_op", f"unsupported op: {op}")

        except Exception as error:  # noqa: BLE001 - one bad request must not stop the daemon
            code, status = classify(error)
            emit_error(request_id, code, str(error), status)


if __name__ == "__main__":
    main()
