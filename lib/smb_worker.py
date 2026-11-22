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

import json
import re
import stat as stat_module
import sys

import smbclient


def fail(code: str, message: str, status: str | None = None) -> "NoReturn":
    payload = {"code": code, "message": message}
    if status is not None:
        payload["status"] = status
    sys.stderr.write(json.dumps(payload, ensure_ascii=False))
    sys.stderr.flush()
    raise SystemExit(1)


def classify(error: Exception) -> tuple[str, str | None]:
    """Map a protocol refusal onto the codes the Host already explains.

    `smbprotocol` reports the NTSTATUS inside the message text
    (`[NtStatus 0xc0000034]`), so the code is the reliable discriminator; the
    prose around it differs between dialects and locales.
    """
    text = str(error)
    match = re.search(r"0x([0-9a-fA-F]{8})", text)
    status = f"0x{match.group(1).upper()}" if match else None
    by_status = {
        "0xC000006D": "auth_failed",   # STATUS_LOGON_FAILURE
        "0xC000006A": "auth_failed",   # STATUS_WRONG_PASSWORD
        "0xC0000022": "denied",        # STATUS_ACCESS_DENIED
        "0xC0000061": "denied",        # STATUS_PRIVILEGE_NOT_HELD
        "0xC00000CC": "no_such_share", # STATUS_BAD_NETWORK_NAME
        "0xC0000225": "no_such_share", # STATUS_NOT_FOUND (tree connect)
        "0xC0000034": "not_found",     # STATUS_OBJECT_NAME_NOT_FOUND
        "0xC000003A": "not_found",     # STATUS_OBJECT_PATH_NOT_FOUND
        "0xC000000F": "not_found",     # STATUS_NO_SUCH_FILE
        "0xC0000103": "wrong_type",    # STATUS_NOT_A_DIRECTORY
        "0xC00000BA": "wrong_type",    # STATUS_FILE_IS_A_DIRECTORY
    }
    if status is not None and status in by_status:
        return by_status[status], status
    lowered = text.lower()
    if "logon" in lowered or "authentication" in lowered:
        return "auth_failed", status
    if "access is denied" in lowered or "access_denied" in lowered:
        return "denied", status
    if "bad network name" in lowered or "bad_network_name" in lowered:
        return "no_such_share", status
    if "no such file" in lowered or "not found" in lowered:
        return "not_found", status
    return "smb_error", status


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
            root = f"\\\\{host}\\{share}"
            target = f"{root}\\{path}" if path else root
            rows = []
            for entry in smbclient.scandir(target):
                rows.append({
                    "name": entry.name,
                    "directory": entry.is_dir(),
                })
            json.dump({"entries": rows}, sys.stdout, ensure_ascii=False)

        elif op == "stat":
            root = f"\\\\{host}\\{share}"
            target = f"{root}\\{path}" if path else root
            info = smbclient.stat(target)
            json.dump({"size": info.st_size, "directory": stat_module.S_ISDIR(info.st_mode)}, sys.stdout)

        elif op == "read":
            root = f"\\\\{host}\\{share}"
            target = f"{root}\\{path}"
            written = 0
            with smbclient.open_file(target, mode="rb") as handle:
                while True:
                    chunk = handle.read(262144)
                    if not chunk:
                        break
                    sys.stdout.buffer.write(chunk)
                    written += len(chunk)
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
