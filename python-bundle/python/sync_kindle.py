#!/usr/bin/env python3
"""Kindle Sync Script — Connects to jailbroken Kindle via SSH, pulls sidecars and books, extracts reading data.

Based on the proven SSH patterns from krd-dashboard.py for reliable binary transfer.
"""

import json
import os
import posixpath
import sys
import shutil
from pathlib import Path

try:
    import paramiko
except ImportError:
    print("ERROR: paramiko not installed", file=sys.stderr)
    sys.exit(1)

# ─── Configuration ───────────────────────────────────────────────────────────

DEFAULT_HOST = "192.168.1.80"
DEFAULT_USER = "root"
DEFAULT_PASSWORD = "kindle"
DEFAULT_CACHE_DIR = os.path.join(os.environ.get("APPDATA", ""), "reading-tracker", "kindle-cache")

# Session-day boundary: a session that ended after midnight but before this
# wall-clock time is attributed to the previous day. "00:00" disables it.
DEFAULT_SESSION_DAY_END = "04:00"

# User-visible partition. Kindle's own library lives in KINDLE_DOC_PATH, but
# KOReader opens books from anywhere under KINDLE_ROOT (and keeps the sidecar
# next to the book), so discovery scans the whole partition.
KINDLE_ROOT = "/mnt/us"
KINDLE_DOC_PATH = "/mnt/us/documents"

# KOReader's install and central metadata dirs never hold sidecars that sit
# next to their book, and hash-named ones can't be mapped back to a book.
SKIPPED_REMOTE_PREFIXES = ("/mnt/us/koreader/", "/mnt/us/system/")

# Remote prefix -> local cache prefix. Documents keep the historical layout
# (no cache migration); everything else is namespaced so the two can't collide.
CACHE_ROOT_MAP = (
    (KINDLE_DOC_PATH + "/", ""),
    (KINDLE_ROOT + "/", "_user/"),
)

# KRDS sidecar extensions — the file suffixes we look for on the Kindle
METRICS_EXTS = (".azw3f", ".yjf", ".mbs")
READER_EXTS = (".azw3r", ".yjr", ".mbp1")
SIDECAR_EXTS = METRICS_EXTS + READER_EXTS

# KOReader strips the book's last suffix for the sidecar folder:
# `Book.epub` -> `Book.sdr/metadata.epub.lua`
KOREADER_METADATA_PATTERN = "metadata.*.lua"

# Book formats the extractor can index (KFX family + EPUB, KOReader's usual format)
BOOK_EXTS = (".azw3", ".azw", ".mobi", ".kfx", ".epub")


# ─── Helpers ─────────────────────────────────────────────────────────────────

def status(msg: str) -> None:
    """Print a status message flushed to stdout."""
    print(msg, flush=True)


def _local_path(remote_path: str, cache_dir: str) -> str:
    """Map a remote device path into the local cache directory.

    Files under KINDLE_DOC_PATH keep the historical cache layout; files
    elsewhere on the partition live under ``_user/`` so the two roots can
    never shadow each other.
    """
    for prefix, local_prefix in CACHE_ROOT_MAP:
        if remote_path.startswith(prefix):
            rel = local_prefix + remote_path[len(prefix):]
            return os.path.join(cache_dir, *rel.split("/"))
    return os.path.join(cache_dir, *posixpath.basename(remote_path).split("/"))


def parse_session_day_end_hour(value: str) -> int:
    """Parse a "HH:MM" (or bare hour) session-day-end value into an hour 0-23.

    Unusable values fall back to the documented default boundary, so a corrupt
    settings file never silently shifts every session by an arbitrary hour.
    """
    try:
        hour = int(str(value).strip().split(":")[0])
    except ValueError:
        hour = -1
    if 0 <= hour <= 23:
        return hour
    return parse_session_day_end_hour(DEFAULT_SESSION_DAY_END)


def load_settings() -> dict:
    """Load Kindle settings from environment variables or defaults."""
    return {
        "host": os.environ.get("KINDLE_HOST", DEFAULT_HOST),
        "user": os.environ.get("KINDLE_USER", DEFAULT_USER),
        "password": os.environ.get("KINDLE_PW", DEFAULT_PASSWORD),
        "ssh_key": os.environ.get("KINDLE_SSH_KEY", ""),
        "cache_dir": os.environ.get("CACHE_DIR", DEFAULT_CACHE_DIR),
        "timezone": os.environ.get("KINDLE_TIMEZONE", "-3"),
        "session_day_end": os.environ.get("KINDLE_SESSION_DAY_END", DEFAULT_SESSION_DAY_END),
    }


# ─── SSH helpers (adapted from krd-dashboard.py) ─────────────────────────────

def _shq(path: str) -> str:
    """Single-quote a path for the remote shell, escaping embedded single quotes."""
    return "'" + path.replace("'", "'\\''") + "'"


def _ssh_read(client: paramiko.SSHClient, remote: str, retries: int = 3) -> bytes:
    """Read a remote file via `cat`, with retries. Returns raw bytes.

    Uses `out.channel.makefile("rb").read()` for reliable binary transfer,
    matching the proven pattern in krd-dashboard.py.
    """
    last = b""
    for _ in range(retries):
        _in, out, err = client.exec_command("cat %s" % _shq(remote))
        data = out.channel.makefile("rb").read()
        out.channel.recv_exit_status()
        if data:
            return data
        last = data
    return last


def connect(settings: dict) -> paramiko.SSHClient:
    """Connect to Kindle via SSH, using ksh-style auth."""
    status("Connecting to Kindle...")
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

    host = settings["host"]
    user = settings["user"]
    password = settings["password"]
    ssh_key = settings["ssh_key"]

    if ssh_key:
        # Key-based auth (supports key-only Kindles)
        client.connect(
            hostname=host,
            username=user,
            key_filename=os.path.expanduser(ssh_key),
            password=password if password else None,
            look_for_keys=True,
            allow_agent=True,
            timeout=15,
        )
    else:
        # Password-only auth
        client.connect(
            hostname=host,
            username=user,
            password=password,
            look_for_keys=False,
            allow_agent=False,
            timeout=15,
        )
    return client


# ─── Sidecar Discovery ───────────────────────────────────────────────────────
def _remote_find(
    client: paramiko.SSHClient,
    patterns: list[str],
    timeout: int = 120,
) -> list[str]:
    """Run `find` over the user partition and return matching remote paths."""
    find_expr = " -o ".join("-name '%s'" % pattern for pattern in patterns)
    cmd = "find '%s' \\( %s \\)" % (KINDLE_ROOT, find_expr)
    _in, out, _err = client.exec_command(cmd, timeout=timeout)
    return [
        path
        for path in out.read().decode("utf-8", "replace").splitlines()
        if path.strip() and not path.startswith(SKIPPED_REMOTE_PREFIXES)
    ]


def discover_sidecars(client: paramiko.SSHClient) -> list[str]:
    """Find Kindle KRDS sidecars and KOReader metadata files using `find`.

    Scans the whole user partition, because KOReader opens books from anywhere
    on it: Kindle sidecars are extension-named files (optionally inside a
    `<title>.sdr` folder), KOReader sidecars are
    `<book-without-ext>.sdr/metadata.<ext>.lua` next to the book.
    """
    status("Discovering sidecars...")
    # Build find expression: -name '*.azw3f' -o -name '*.yjf' -o ...
    patterns = ["*.%s" % ext.lstrip(".") for ext in SIDECAR_EXTS]
    patterns.append(KOREADER_METADATA_PATTERN)
    files = _remote_find(client, patterns)

    koreader_count = sum(
        1 for path in files
        if posixpath.basename(path).startswith("metadata.") and path.endswith(".lua")
    )
    status("Found %d sidecars (%d Kindle, %d KOReader)" % (
        len(files), len(files) - koreader_count, koreader_count,
    ))
    return files


# ─── File Pulling ────────────────────────────────────────────────────────────

def pull_sidecar(client: paramiko.SSHClient, remote_path: str, docs_cache: str) -> None:
    """Pull a single sidecar file from Kindle using proven _ssh_read pattern."""
    local = _local_path(remote_path, docs_cache)
    os.makedirs(os.path.dirname(local), exist_ok=True)

    # Use proven _ssh_read for reliable binary transfer
    data = _ssh_read(client, remote_path)
    with open(local, "wb") as f:
        f.write(data)


def pull_book(client: paramiko.SSHClient, remote_path: str, cache_dir: str) -> None:
    """Pull a single book file from Kindle using proven _ssh_read pattern."""
    local = _local_path(remote_path, cache_dir)
    os.makedirs(os.path.dirname(local), exist_ok=True)

    data = _ssh_read(client, remote_path)
    with open(local, "wb") as f:
        f.write(data)


def _book_stem(name: str) -> str:
    """Reduce a book or sidecar file name to its book stem.

    Kindle sidecars are ``Book.sdr/Book.yjr``. KOReader strips the book's last
    suffix for the folder (``Book.epub`` -> ``Book.sdr/metadata.epub.lua``),
    but some layouts keep it (``Book.epub.sdr``), so strip ``.sdr`` and every
    known book/sidecar extension rather than exactly one.
    """
    while True:
        lowered = name.lower()
        for ext in (".sdr",) + BOOK_EXTS + SIDECAR_EXTS:
            if lowered.endswith(ext):
                name = name[:-len(ext)]
                break
        else:
            return name


def find_books_to_pull(client: paramiko.SSHClient, cache_dir: str) -> list[str]:
    """Find book files that have valid reading data and are missing from the cache.

    Uses the same `find` pattern as discover_sidecars for book extensions,
    then filters against valid sidecars from run_scan_only.
    """
    # Import run_scan_only directly from top-level package
    sys.path.insert(0, str(Path(__file__).parent))
    from kfx_text_extractor import run_scan_only

    # Get valid sidecar paths from local cache
    valid_sidecar_paths = run_scan_only(str(cache_dir))
    valid_stems = {_book_stem(Path(path).name) for path in valid_sidecar_paths}

    # Find all book files on Kindle using `find` (same pattern as discover_sidecars)
    book_files = _remote_find(client, ["*" + ext for ext in BOOK_EXTS])

    # Filter books: only pull if the book has a valid sidecar and
    # the book doesn't already exist in the local cache
    books_to_pull = []
    for book_remote in book_files:
        if _book_stem(Path(book_remote).name) not in valid_stems:
            continue

        local_book = _local_path(book_remote, cache_dir)
        if not os.path.exists(local_book):
            books_to_pull.append(book_remote)

    return books_to_pull

# ─── SSH Connection Test ─────────────────────────────────────────────────────

def test_ssh_connection() -> bool:
    """Test SSH connection by running a simple command.

    Prints ``__SSH_TEST_RESULT__: true`` or ``__SSH_TEST_RESULT__: false``
    so that callers that spawn this script as a subprocess can parse the
    outcome reliably.
    """
    settings = load_settings()

    client = connect(settings)
    success = False
    error_msg = ""

    try:
        _in, out, _err = client.exec_command("echo 'SSH connection test'", timeout=5)
        output = out.read().decode("utf-8", "replace").strip()
        success = output == "SSH connection test"
    except Exception as e:
        error_msg = str(e)
        print(f"SSH connection test failed: {error_msg}", flush=True)
    finally:
        try:
            client.close()
        except Exception:
            pass

    # Always print a parseable result marker
    result = "true" if success else "false"
    print(f"__SSH_TEST_RESULT__: {result}", flush=True)
    return success


# ─── Main Sync Logic ─────────────────────────────────────────────────────────

def run_sync(from_cache: bool = False) -> dict:
    """Run the full Kindle sync pipeline."""
    settings = load_settings()
    cache_dir = Path(settings["cache_dir"])
    os.makedirs(cache_dir, exist_ok=True)
    
    client = connect(settings)

    try:
        # Phase 1: Discover sidecars on Kindle (using proven find pattern)
        sidecar_paths = discover_sidecars(client)
        if not sidecar_paths:
            return {
                "sessions": [],
                "stats": {"sidecarsPulled": 0, "booksPulled": 0, "sessionsExtracted": 0},
            }

        # Phase 2: Pull ALL sidecars (always, no filtering)
        status("Pulling sidecars... (%d files)" % len(sidecar_paths))
        for i, remote in enumerate(sidecar_paths, 1):
            pull_sidecar(client, remote, cache_dir)
            if i % 10 == 0 or i == len(sidecar_paths):
                status("  %d/%d" % (i, len(sidecar_paths)))

        # Phase 3: Find and pull books (only for sidecars with valid reading data)
        status("Analyzing sidecars...")
        books_to_pull = find_books_to_pull(client, str(cache_dir))
        books_pulled = 0
        if books_to_pull:
            status("Pulling book files... (%d books)" % len(books_to_pull))
            for i, book_path in enumerate(books_to_pull, 1):
                pull_book(client, book_path, str(cache_dir))
                books_pulled += 1
                status("  %d/%d" % (i, len(books_to_pull)))

        # Phase 4: Run kfx_text_extractor run_sidecar_mode on the local cache
        status("Extracting reading data...")
        sys.path.insert(0, str(Path(__file__).parent))
        from kfx_text_extractor import run_sidecar_mode

        timezone = settings.get("timezone", "-3")
        day_end_hour = parse_session_day_end_hour(settings["session_day_end"])
        status("Session day ends at %02d:00" % day_end_hour)
        result = run_sidecar_mode(sidecar_dir=str(cache_dir), columns=['session_date', 'book_title', 'language', 'char_count', 'session_duration'], timezone=timezone, session_adjustment_hours=day_end_hour)
        sessions = result.get("sessions", [])

        # Phase 5: Output result
        output = {
            "sessions": sessions,
            "stats": {
                "sidecarsPulled": len(sidecar_paths),
                "booksPulled": books_pulled,
                "sessionsExtracted": len(sessions),
            },
        }

        status("Sync complete!")
        print("__RESULT__", flush=True)
        print(json.dumps(output, ensure_ascii=False), flush=True)

        return output

    finally:
        client.close()


if __name__ == "__main__":
    import sys as _sys
    
    if "--test-ssh" in _sys.argv[1:]:
        test_ssh_connection()
    else:
        run_sync()
