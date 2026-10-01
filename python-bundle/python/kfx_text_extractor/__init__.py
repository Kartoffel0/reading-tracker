"""KFX Text Extractor — extract highlighted text from KFX books using position data."""

from .sidecar_annotation_extractor import (
    extract_from_sidecars,
    list_valid_sidecars,
    ClippingEntry,
)
from .text_extractor import extract_text
from .csv_exporter import export_sessions, export_sessions_to_dicts

# Lazy import for build_pid_index to avoid eager kfxlib import
def __getattr__(name):
    if name == "build_pid_index":
        from .kfx_index import build_pid_index
        return build_pid_index
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")

# Public CLI functions (importable from top-level package)
from .cli import (
    run_scan_only,
    run_sidecar_mode,
)

__all__ = [
    "ClippingEntry",
    "extract_from_sidecars",
    "list_valid_sidecars",
    "build_pid_index",
    "extract_text",
    "export_sessions",
    "export_sessions_to_dicts",
    "run_scan_only",
    "run_sidecar_mode",
]
