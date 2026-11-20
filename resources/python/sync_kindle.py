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

# Incremental sync bookkeeping: remote sidecar path -> mtime reported by the
# device at the last successful pull. A sidecar whose mtime did not move holds
# no new reading data, so re-reading it over SSH every sync is pure waste.
# The extractor still re-parses every cached sidecar, which is local and cheap.
SIDECAR_MTIME_MANIFEST = ".sidecar-mtimes.json"


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


def load_sidecar_mtimes(cache_dir: str) -> dict:
    """Load the remote-path -> mtime map from the cache directory.

    A missing, unreadable or malformed manifest means "unknown", so the next
    sync pulls everything once and rewrites it.
    """
    try:
        with open(os.path.join(cache_dir, SIDECAR_MTIME_MANIFEST), "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    return {str(path): str(mtime) for path, mtime in data.items()}


def save_sidecar_mtimes(cache_dir: str, mtimes: dict) -> None:
    """Write the mtime map atomically so a crash never leaves it half-written."""
    path = os.path.join(cache_dir, SIDECAR_MTIME_MANIFEST)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(mtimes, f, indent=0, sort_keys=True)
    os.replace(tmp, path)


def sidecar_dirs(local_paths: list[str]) -> list[str]:
    """Collapse cached sidecar file paths to the .sdr folders the extractor scans."""
    dirs = set()
    for path in local_paths:
        parent = Path(path).parent
        while parent != parent.parent:
            if parent.name.lower().endswith(".sdr"):
                dirs.add(str(parent))
                break
            parent = parent.parent
    return sorted(dirs)


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
def _find_expression(patterns: list[str]) -> str:
    """Build the `-name ... -o -name ...` half of a remote find command."""
    return " -o ".join("-name '%s'" % pattern for pattern in patterns)


def _remote_find(
    client: paramiko.SSHClient,
    patterns: list[str],
    timeout: int = 120,
) -> list[str]:
    """Run `find` over the user partition and return matching remote paths."""
    cmd = "find '%s' \\( %s \\)" % (KINDLE_ROOT, _find_expression(patterns))
    _in, out, _err = client.exec_command(cmd, timeout=timeout)
    return [
        path
        for path in out.read().decode("utf-8", "replace").splitlines()
        if path.strip() and not path.startswith(SKIPPED_REMOTE_PREFIXES)
    ]


def _mtime_find_command(patterns: list[str], style: str) -> str:
    """Build a remote find command that prints "<epoch seconds> <path>" lines.

    ``printf`` is the GNU extension (one process); ``stat`` is the busybox-safe
    fallback that execs `stat` per match.
    """
    body = "find '%s' \\( %s \\)" % (KINDLE_ROOT, _find_expression(patterns))
    if style == "printf":
        return body + " -printf '%%T@ %%p\\n'"
    return body + " -exec stat -c '%Y %n' {} \\;"


def _run_mtime_find(client: paramiko.SSHClient, cmd: str, timeout: int) -> dict[str, str] | None:
    """Run an mtime find; None when the device lacks the flag or prints garbage."""
    _in, out, _err = client.exec_command(cmd, timeout=timeout)
    data = out.read().decode("utf-8", "replace")
    if out.channel.recv_exit_status() != 0:
        return None

    mtimes = {}
    for line in data.splitlines():
        mtime, _, path = line.partition(" ")
        if not path or not mtime.replace(".", "", 1).isdigit():
            return None
        if path.startswith(SKIPPED_REMOTE_PREFIXES):
            continue
        mtimes[path] = mtime
    return mtimes


def _detect_mtime_style(client: paramiko.SSHClient) -> str | None:
    """Probe which find action reports mtimes, cheaply.

    Each probe runs on KINDLE_ROOT alone (`-maxdepth 0`), so unsupported flags
    cost one round trip instead of a full-partition scan. Busybox builds often
    ship `stat` without GNU `find -printf`, and vice versa.
    """
    actions = (
        ("printf", "-printf '%%T@ %%p\\n'"),
        ("stat", "-exec stat -c '%Y %n' {} \\;"),
    )
    for style, action in actions:
        cmd = "find '%s' -maxdepth 0 %s" % (KINDLE_ROOT, action)
        _in, out, _err = client.exec_command(cmd, timeout=20)
        data = out.read().decode("utf-8", "replace").strip()
        if out.channel.recv_exit_status() == 0 and data:
            return style
    return None


def _remote_find_mtimes(
    client: paramiko.SSHClient,
    patterns: list[str],
    timeout: int = 120,
) -> dict[str, str] | None:
    """Map matching remote paths to their device mtime (epoch seconds).

    Tries GNU ``-printf`` first, then ``-exec stat`` (busybox usually ships
    ``stat`` even when ``find`` has no ``-printf``). Returns None when neither
    works, so callers fall back to a full pull instead of silently skipping
    sidecars.
    """
    style = _detect_mtime_style(client)
    if style is None:
        return None
    mtimes = _run_mtime_find(client, _mtime_find_command(patterns, style), timeout)
    if mtimes is None:
        return None
    status("Reading device mtimes via find %s." % ("-printf" if style == "printf" else "-exec stat"))
    return mtimes


def discover_sidecars(client: paramiko.SSHClient) -> list[tuple[str, str | None]]:
    """Find Kindle KRDS sidecars and KOReader metadata files using `find`.

    Scans the whole user partition, because KOReader opens books from anywhere
    on it: Kindle sidecars are extension-named files (optionally inside a
    `<title>.sdr` folder), KOReader sidecars are
    `<book-without-ext>.sdr/metadata.<ext>.lua` next to the book.

    Returns ``(remote path, mtime)`` pairs, with ``mtime`` None when the device
    cannot report timestamps.
    """
    status("Discovering sidecars...")
    # Build find expression: -name '*.azw3f' -o -name '*.yjf' -o ...
    patterns = ["*.%s" % ext.lstrip(".") for ext in SIDECAR_EXTS]
    patterns.append(KOREADER_METADATA_PATTERN)

    mtimes = _remote_find_mtimes(client, patterns)
    if mtimes is None:
        status("Device cannot report sidecar mtimes; pulling every sidecar.")
        files = [(path, None) for path in _remote_find(client, patterns)]
    else:
        files = sorted(mtimes.items())

    koreader_count = sum(
        1 for path, _mtime in files
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

def run_sync(from_cache: bool = False, force: bool = False) -> dict:
    """Run the full Kindle sync pipeline.

    ``force`` ignores the cached sidecar mtimes and re-pulls/re-extracts every
    sidecar, which is what the "Force Full Sync" button needs.
    """
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
                "stats": {
                    "sidecarsPulled": 0,
                    "sidecarsSkipped": 0,
                    "booksPulled": 0,
                    "sessionsExtracted": 0,
                },
            }

        # Phase 2: Pull sidecars the device reports as changed. Re-reading an
        # unchanged sidecar only re-fetches bytes the cache already has.
        known_mtimes = load_sidecar_mtimes(str(cache_dir))
        if force:
            status("Force scan: ignoring cached sidecar mtimes.")
            known_mtimes = {}
        pending = []
        sidecars_skipped = 0
        for remote, mtime in sidecar_paths:
            local = _local_path(remote, str(cache_dir))
            if mtime is not None and known_mtimes.get(remote) == mtime and os.path.exists(local):
                sidecars_skipped += 1
                continue
            pending.append((remote, mtime))

        status("Pulling sidecars... (%d files, %d unchanged)" % (len(pending), sidecars_skipped))
        for i, (remote, mtime) in enumerate(pending, 1):
            pull_sidecar(client, remote, cache_dir)
            if mtime is not None:
                known_mtimes[remote] = mtime
            if i % 10 == 0 or i == len(pending):
                status("  %d/%d" % (i, len(pending)))

        # Device-side deletions drop out of the manifest; if the device cannot
        # report mtimes, leave the previous manifest untouched.
        mtimes_reported = any(mtime is not None for _remote, mtime in sidecar_paths)
        if mtimes_reported:
            discovered = {remote for remote, _mtime in sidecar_paths}
            known_mtimes = {path: mtime for path, mtime in known_mtimes.items() if path in discovered}

        books_pulled = 0
        sessions = []
        if not pending:
            # Nothing was pulled, so there is nothing to extract and no new
            # book can be needed yet: book analysis runs alongside a pull.
            status("Nothing new on the device; skipping book analysis and extraction.")
        else:
            # Phase 3: Find and pull books (only for sidecars with valid reading data)
            status("Analyzing sidecars...")
            books_to_pull = find_books_to_pull(client, str(cache_dir))
            if books_to_pull:
                status("Pulling book files... (%d books)" % len(books_to_pull))
                for i, book_path in enumerate(books_to_pull, 1):
                    pull_book(client, book_path, str(cache_dir))
                    books_pulled += 1
                    status("  %d/%d" % (i, len(books_to_pull)))

            # Phase 4: Extract only the sidecars this sync pulled. Books sit next
            # to their .sdr in the cache, so matching works without a second copy.
            pending_dirs = sidecar_dirs(
                [_local_path(remote, str(cache_dir)) for remote, _mtime in pending]
            )
            if pending_dirs:
                status("Extracting reading data... (%d sidecar folders)" % len(pending_dirs))
                sys.path.insert(0, str(Path(__file__).parent))
                from kfx_text_extractor import run_sidecar_mode

                timezone = settings.get("timezone", "-3")
                day_end_hour = parse_session_day_end_hour(settings["session_day_end"])
                status("Session day ends at %02d:00" % day_end_hour)
                result = run_sidecar_mode(
                    sidecar_dir=str(cache_dir),
                    columns=['session_date', 'book_title', 'language', 'char_count', 'session_duration'],
                    timezone=timezone,
                    session_adjustment_hours=day_end_hour,
                    sidecars=pending_dirs,
                )
                sessions = result.get("sessions", [])
            else:
                status("No new sidecar folders; skipping extraction.")

        # The manifest advances only after the pulled sidecars are extracted, so
        # a crash mid-extraction retries them next sync instead of dropping
        # their sessions forever.
        if mtimes_reported:
            save_sidecar_mtimes(str(cache_dir), known_mtimes)

        # Phase 5: Output result
        output = {
            "sessions": sessions,
            "stats": {
                "sidecarsPulled": len(pending),
                "sidecarsSkipped": sidecars_skipped,
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
        run_sync(force="--force" in _sys.argv[1:])
