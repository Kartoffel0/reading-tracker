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

KINDLE_DOC_PATH = "/mnt/us/documents"

# KRDS sidecar extensions — the file suffixes we look for on the Kindle
METRICS_EXTS = (".azw3f", ".yjf", ".mbs")
READER_EXTS = (".azw3r", ".yjr", ".mbp1")
SIDECAR_EXTS = METRICS_EXTS + READER_EXTS

BOOK_EXTS = (".azw3", ".azw", ".mobi", ".kfx")


# ─── Helpers ─────────────────────────────────────────────────────────────────

def status(msg: str) -> None:
    """Print a status message flushed to stdout."""
    print(msg, flush=True)


def load_settings() -> dict:
    """Load Kindle settings from environment variables or defaults."""
    return {
        "host": os.environ.get("KINDLE_HOST", DEFAULT_HOST),
        "user": os.environ.get("KINDLE_USER", DEFAULT_USER),
        "password": os.environ.get("KINDLE_PW", DEFAULT_PASSWORD),
        "ssh_key": os.environ.get("KINDLE_SSH_KEY", ""),
        "cache_dir": os.environ.get("CACHE_DIR", DEFAULT_CACHE_DIR),
        "timezone": os.environ.get("KINDLE_TIMEZONE", "-3"),
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
def discover_sidecars(client: paramiko.SSHClient) -> list[str]:
    """Find all sidecar files on Kindle using `find` with known extensions.

    Uses the same `find` pattern as krd-dashboard.py for reliability.
    """
    status("Discovering sidecars...")
    # Build find expression: -name '*.azw3f' -o -name '*.yjf' -o ...
    find_expr = " -o ".join("-name '*%s'" % ext for ext in SIDECAR_EXTS)
    cmd = "find '%s' \\( %s \\)" % (KINDLE_DOC_PATH, find_expr)
    _in, out, _err = client.exec_command(cmd, timeout=30)
    files = [
        l for l in out.read().decode("utf-8", "replace").splitlines()
        if l.strip()
    ]
    status("Found %d sidecars" % len(files))
    print(files)
    return files


def discover_sdr_folders(client: paramiko.SSHClient) -> list[str]:
    """Find all .sdr folders on Kindle (legacy compatibility)."""
    status("Discovering .sdr folders...")
    stdin, stdout, stderr = client.exec_command(
        "find '%s' -name '*.sdr' -type d 2>/dev/null" % _shq(KINDLE_DOC_PATH),
        timeout=30
    )
    output = stdout.read().decode("utf-8", "replace").strip()
    if not output:
        return []
    return [l for l in output.split("\n") if l.strip()]


# ─── File Pulling ────────────────────────────────────────────────────────────

def pull_sidecar(client: paramiko.SSHClient, remote_path: str, docs_cache: str) -> None:
    """Pull a single sidecar file from Kindle using proven _ssh_read pattern."""
    # Compute local path relative to docs_cache
    rel = posixpath.relpath(remote_path, KINDLE_DOC_PATH)
    local = os.path.join(docs_cache, *rel.split("/"))
    os.makedirs(os.path.dirname(local), exist_ok=True)

    # Use proven _ssh_read for reliable binary transfer
    data = _ssh_read(client, remote_path)
    with open(local, "wb") as f:
        f.write(data)


def pull_sidecar_folder(client: paramiko.SSHClient, remote_dir: str, local_dir: str) -> None:
    """Pull all files from a .sdr folder on Kindle."""
    # List files in the remote folder
    stdin, stdout, stderr = client.exec_command(
        "ls '%s'" % _shq(remote_dir), timeout=10
    )
    files = stdout.read().decode("utf-8", "replace").strip().split("\n")

    for fname in files:
        if not fname:
            continue
        remote_file = posixpath.join(remote_dir, fname)
        local_file = os.path.join(local_dir, fname)

        # Use proven _ssh_read for reliable binary transfer
        data = _ssh_read(client, remote_file)
        if data:
            with open(local_file, "wb") as f:
                f.write(data)


def pull_book(client: paramiko.SSHClient, remote_path: str, cache_dir: str) -> None:
    """Pull a single book file from Kindle using proven _ssh_read pattern."""
    rel = posixpath.relpath(remote_path, KINDLE_DOC_PATH)
    local = os.path.join(cache_dir, rel)
    os.makedirs(os.path.dirname(local), exist_ok=True)

    data = _ssh_read(client, remote_path)
    with open(local, "wb") as f:
        f.write(data)


def find_books_to_pull(
    client: paramiko.SSHClient,
    all_sidecar_paths: list[str],
    cache_dir: str,
) -> list[str]:
    """Find book files (.kfx, .azw3, .azw, .mobi) that need to be pulled.

    Uses the same `find` pattern as discover_sidecars for book extensions,
    then filters against valid sidecars from run_scan_only.
    """
    # Import run_scan_only directly from top-level package
    sys.path.insert(0, str(Path(__file__).parent))
    from kfx_text_extractor import run_scan_only

    # Get valid sidecar paths from local cache
    valid_sidecar_paths = run_scan_only(str(cache_dir))

    # Build set of valid book base names from sidecar paths
    # Strip sidecar extensions (or .sdr) to get the base book name
    valid_bases = set()
    for path in valid_sidecar_paths:
        path_name = Path(path).name
        # Try stripping sidecar extensions first
        for ext in SIDECAR_EXTS:
            if path_name.endswith(ext):
                valid_bases.add(path_name[:-len(ext)])
                break
            else:
                # If not a sidecar extension, check for .sdr
                if path_name.endswith('.sdr'):
                    valid_bases.add(path_name[:-4])

    # Find all book files on Kindle using `find` (same pattern as discover_sidecars)
    find_expr = " -o ".join("-name '*%s'" % ext for ext in BOOK_EXTS)
    cmd = "find '%s' \\( %s \\)" % (KINDLE_DOC_PATH, find_expr)
    _in, out, _err = client.exec_command(cmd, timeout=30)
    book_files = [
        l for l in out.read().decode("utf-8", "replace").splitlines()
        if l.strip()
    ]

    # Filter books: only pull if the book base name is in valid_bases
    # and the book doesn't already exist in the local cache
    books_to_pull = []
    for book_remote in book_files:
        book_filename = Path(book_remote).name
        # Strip book extension to get base name
        book_base = book_filename
        for ext in BOOK_EXTS:
            if book_filename.endswith(ext):
                book_base = book_filename[:-len(ext)]
                break

        if book_base not in valid_bases:
            continue

        # Check if book already exists locally
        book_rel = book_filename
        local_book = os.path.join(cache_dir, book_rel).replace("/", os.sep)
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
        books_to_pull = find_books_to_pull(client, sidecar_paths, str(cache_dir))
        print(books_to_pull)
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
        result = run_sidecar_mode(sidecar_dir=str(cache_dir), columns=['session_date', 'book_title', 'language', 'char_count', 'session_duration'], timezone=timezone)
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
