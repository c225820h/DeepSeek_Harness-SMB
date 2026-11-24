#!/usr/bin/env python3
"""One-shot SMB worker that streams one original file to stdout.

Split from `smb_daemon.py` on purpose. The daemon holds the authenticated
session that answers listings and thumbnails, and it is strictly serial — so
piping a multi-megabyte original through it would stall every other request
until the transfer finished. A dedicated process per download keeps the shared
pipe free, and its lifetime is exactly the length of one response body.

`smbprotocol` rather than a pure-JS client: the JS one this plugin started with
could authenticate but had every directory query refused by this Samba with
STATUS_OBJECT_NAME_INVALID.

Contract:
  - settings arrive on stdin as one JSON object (so the password never appears
    in `ps` or in the process environment);
  - the operation name arrives as argv[1] (`read`);
  - the file's bytes go to stdout;
  - any failure prints one JSON object to stderr and exits non-zero.

Read-only: this worker never writes to the share.
"""

from __future__ import annotations

import json
import sys

import smbclient

from smb_common import classify, share_target


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
        if op == "read":
            target = share_target(host, share, path)
            with smbclient.open_file(target, mode="rb") as handle:
                while True:
                    chunk = handle.read(262144)
                    if not chunk:
                        break
                    sys.stdout.buffer.write(chunk)
            sys.stdout.buffer.flush()
        else:
            fail("bad_op", f"unsupported op: {op}")

    except SystemExit:
        raise
    except Exception as error:  # noqa: BLE001
        code, status = classify(error)
        fail(code, str(error), status)


if __name__ == "__main__":
    main()
