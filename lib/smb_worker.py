#!/usr/bin/env python3
"""One-shot SMB worker for dsh-smb-picker.

The Node SMB client this plugin started with could authenticate against a Samba
share but had its directory query refused with STATUS_OBJECT_NAME_INVALID, even
though the request bytes match MS-SMB2 §2.2.33 exactly. `smbprotocol` is the
Samba-side reference implementation, so the Host shells out to this worker
instead of reimplementing the protocol.

Contract, on purpose: one process per request, no daemon, no state.
  - settings arrive on stdin as one JSON object (so the password never appears
    in `ps` or in the process environment);
  - the operation name arrives as argv[1];
  - results go to stdout — JSON for `list` / `shares` / `stat`, raw bytes for
    `read`;
  - any failure prints one JSON object to stderr and exits non-zero.

Every operation is read-only: this worker never writes to the share.
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


def main() -> None:
    if len(sys.argv) < 2:
        fail("bad_invocation", "usage: smb_worker.py <op> < settings.json")
    op = sys.argv[1]
    try:
        settings = json.load(sys.stdin)
    except Exception:
        fail("bad_settings", "settings must be JSON on stdin")

    host = str(settings.get("host", "")).strip()
    username = str(settings.get("username", "")).strip()
    if not host or not username:
        fail("bad_settings", "host and username are required")

    port = int(settings.get("port") or 445)
    share = str(settings.get("share", "")).strip()
    path = str(settings.get("path") or "").replace("/", "\\").strip("\\")

    try:
        smbclient.register_session(
            host,
            username=username,
            password=settings.get("password") or "",
            port=port,
            connection_timeout=settings.get("connectTimeout") or 10,
        )
    except Exception as error:  # noqa: BLE001 - the classification below is the contract
        code, status = classify(error)
        fail(code, str(error), status)

    try:
        if op == "shares":
            rows = []
            for entry in smbclient.list_shares(host, port=port):
                rows.append({
                    "name": entry["name"],
                    "type": "special" if entry.get("special") else "disk",
                })
            json.dump({"shares": rows}, sys.stdout, ensure_ascii=False)

        elif op == "list":
            target = share_target(host, share, path)
            rows = []
            for entry in smbclient.scandir(target):
                rows.append({
                    "name": entry.name,
                    "directory": entry.is_dir(),
                })
            json.dump({"entries": rows}, sys.stdout, ensure_ascii=False)

        elif op == "stat":
            target = share_target(host, share, path)
            info = smbclient.stat(target)
            json.dump({"size": info.st_size, "directory": stat_module.S_ISDIR(info.st_mode)}, sys.stdout)

        elif op == "read":
            target = share_target(host, share, path)
            with smbclient.open_file(target, mode="rb") as handle:
                while True:
                    chunk = handle.read(262144)
                    if not chunk:
                        break
                    sys.stdout.buffer.write(chunk)
            sys.stdout.buffer.flush()

        elif op == "thumb":
            target = share_target(host, share, path)
            width = int(settings.get("width") or 400)
            info = smbclient.stat(target)
            if stat_module.S_ISDIR(info.st_mode):
                fail("wrong_type", "这是一个目录，不是文件")
            if info.st_size > MAX_THUMB_SOURCE_BYTES:
                fail("too_large", f"文件 {info.st_size} 字节，超过缩略图上限")
            with smbclient.open_file(target, mode="rb") as handle:
                source = handle.read()
            image = PIL.Image.open(io.BytesIO(source))
            image = PIL.ImageOps.exif_transpose(image)
            image.thumbnail((width, width), PIL.Image.LANCZOS)
            if image.mode not in ("RGB", "RGBA"):
                image = image.convert("RGBA" if "A" in image.getbands() else "RGB")
            out = io.BytesIO()
            image.save(out, format="WEBP", quality=82, method=4)
            sys.stdout.buffer.write(out.getvalue())
            sys.stdout.buffer.flush()

        else:
            fail("bad_op", f"unknown op: {op}")

    except SystemExit:
        raise
    except Exception as error:  # noqa: BLE001
        code, status = classify(error)
        fail(code, str(error), status)


if __name__ == "__main__":
    main()
