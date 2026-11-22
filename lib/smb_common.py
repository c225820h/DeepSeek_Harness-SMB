"""Shared SMB helpers for dsh-smb-picker's two Python entry points.

`smb_worker.py` handles one request per process (used for streaming an original
file, where a dedicated pipe is simpler than multiplexing). `smb_daemon.py`
keeps one authenticated session and answers many requests, which removes the
per-thumbnail cost of process start plus NTLM handshake.

Both import the error classification from here so a refusal is described the
same way whichever path served it.
"""

from __future__ import annotations

import re

#: A grid thumbnail never needs a source this large; anything bigger is refused.
MAX_THUMB_SOURCE_BYTES = 80 * 1024 * 1024

#: NTSTATUS → the code names the Host already turns into operator-facing copy.
BY_STATUS = {
    "0xC000006D": "auth_failed",    # STATUS_LOGON_FAILURE
    "0xC000006A": "auth_failed",    # STATUS_WRONG_PASSWORD
    "0xC0000022": "denied",         # STATUS_ACCESS_DENIED
    "0xC0000061": "denied",         # STATUS_PRIVILEGE_NOT_HELD
    "0xC00000CC": "no_such_share",  # STATUS_BAD_NETWORK_NAME
    "0xC0000225": "no_such_share",  # STATUS_NOT_FOUND during tree connect
    "0xC0000034": "not_found",      # STATUS_OBJECT_NAME_NOT_FOUND
    "0xC000003A": "not_found",      # STATUS_OBJECT_PATH_NOT_FOUND
    "0xC000000F": "not_found",      # STATUS_NO_SUCH_FILE
    "0xC0000103": "wrong_type",     # STATUS_NOT_A_DIRECTORY
    "0xC00000BA": "wrong_type",     # STATUS_FILE_IS_A_DIRECTORY
}


def extract_status(text: str) -> str | None:
    """Pull the NTSTATUS out of a `smbprotocol` message, if it carries one."""
    match = re.search(r"0x([0-9a-fA-F]{8})", text)
    return f"0x{match.group(1).upper()}" if match else None


def classify(error: Exception) -> tuple[str, str | None]:
    """Map a protocol refusal onto the codes the Host already explains.

    `smbprotocol` reports the NTSTATUS inside the message text
    (`[NtStatus 0xc0000034]`), so the code is the reliable discriminator; the
    prose around it differs between dialects and locales.
    """
    text = str(error)
    status = extract_status(text)
    if status is not None and status in BY_STATUS:
        return BY_STATUS[status], status
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


def share_root(host: str, share: str) -> str:
    """UNC root for one share."""
    return f"\\\\{host}\\{share}"


def share_target(host: str, share: str, path: str) -> str:
    """Absolute UNC path for one entry inside a share."""
    root = share_root(host, share)
    cleaned = path.replace("/", "\\").strip("\\")
    return f"{root}\\{cleaned}" if cleaned else root
