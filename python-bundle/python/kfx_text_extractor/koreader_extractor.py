"""Extract Krs.start/Krs.end reading sessions from KOReader sidecars.

KOReader keeps its reader state in ``<book>.sdr/metadata.<format>.lua``, next to
the book file. Unlike Kindle sidecars, the file inside the ``.sdr`` folder is
not named after the book: the book name lives in the folder name, and the
format lives in the metadata file name (``metadata.epub.lua``).

Each annotation entry holds the highlight itself (``pos0``/``pos1`` CREngine
XPointers, ``text``) plus an optional ``note``. ``krs.start``/``krs.end`` notes
mark reading-session boundaries exactly like the Kindle sidecar markers.
"""

import glob
import logging
import os

from .lua_literal import load_lua_table
from .sidecar_annotation_extractor import (
    ClippingEntry,
    KRS_END_MARKER,
    KRS_START_MARKER,
)

# KOReader sidecar metadata file, e.g. metadata.epub.lua / metadata.pdf.lua
KOREADER_METADATA_PATTERN = "metadata.*.lua"


def find_koreader_metadata(sdr_dir):
    """Return the KOReader metadata file inside an .sdr directory, if any.

    EPUB metadata is preferred when several formats are present.
    """
    matches = glob.glob(os.path.join(sdr_dir, KOREADER_METADATA_PATTERN))
    matches.sort(key=lambda path: (not path.lower().endswith(".epub.lua"), path))
    return matches[0] if matches else None


def _book_extension(metadata_path):
    """Derive the book extension from ``metadata.<format>.lua``."""
    name = os.path.basename(metadata_path)
    prefix = "metadata."
    if not name.startswith(prefix) or not name.endswith(".lua"):
        return None
    stem = name[len(prefix):-len(".lua")]
    return "." + stem.lower() if stem else None


def _book_title(sdr_dir):
    """Derive the book title from the .sdr folder name (sidecar files have no name)."""
    folder = os.path.basename(os.path.normpath(sdr_dir))
    if folder.lower().endswith(".sdr"):
        folder = folder[:-len(".sdr")]
    return folder


def _annotation_list(metadata):
    """Return the annotation entries in KOReader's stored order."""
    annotations = metadata.get("annotations")
    if isinstance(annotations, list):
        return [entry for entry in annotations if isinstance(entry, dict)]
    if not isinstance(annotations, dict):
        return []

    def _order(item):
        key = item[0]
        return (0, key) if isinstance(key, int) else (1, str(key))

    return [entry for _, entry in sorted(annotations.items(), key=_order) if isinstance(entry, dict)]


def _annotation_date(annotation):
    """Read an annotation timestamp as an ISO 8601 string.

    KOReader writes device-local wall-clock time with no offset, so the value
    stays naive; the exporter interprets it in the configured timezone.
    """
    for field in ("datetime", "datetime_updated"):
        value = annotation.get(field)
        if isinstance(value, str) and value.strip():
            return value.strip().replace(" ", "T", 1)
    return ""


def _marker_type(annotation):
    """Return 'start'/'end' for a Krs marker annotation, else None."""
    note = annotation.get("note")
    if not isinstance(note, str):
        return None
    lowered = note.lower()
    if KRS_START_MARKER.lower() in lowered:
        return "start"
    if KRS_END_MARKER.lower() in lowered:
        return "end"
    return None


def _collect_markers(annotations):
    """Collect Krs markers sorted chronologically."""
    markers = []
    for index, annotation in enumerate(annotations):
        marker_type = _marker_type(annotation)
        if marker_type is None:
            continue
        position = annotation.get("pos0" if marker_type == "start" else "pos1")
        if not position:
            continue
        markers.append({
            "type": marker_type,
            "position": position,
            "annotation": annotation,
            "date": _annotation_date(annotation),
            "index": index,
        })

    markers.sort(key=lambda marker: (marker["date"], marker["index"]))
    return markers


def _pair_markers(markers, book_title, book_ext):
    """Pair Krs markers into reading sessions, dropping duplicate boundaries.

    Same rules as the Kindle sidecar pairing: a repeated Krs.start invalidates
    the earlier one, a repeated Krs.end invalidates the later one.
    """
    processed = [dict(marker, is_valid=True) for marker in markers]

    for index in range(1, len(processed)):
        current = processed[index]
        previous = processed[index - 1]

        if current["type"] == previous["type"] == "start":
            previous["is_valid"] = False
            logging.warning(
                "Book '%s': Consecutive Krs.start at %s and %s - keeping the later marker",
                book_title, previous["position"], current["position"],
            )
        elif current["type"] == previous["type"] == "end":
            current["is_valid"] = False
            logging.warning(
                "Book '%s': Consecutive Krs.end at %s and %s - keeping the earlier marker",
                book_title, previous["position"], current["position"],
            )

    # Walk markers chronologically: an end only closes the latest open start,
    # so stray or out-of-order markers never produce inverted sessions.
    sessions = []
    pending_start = None
    for entry in processed:
        if not entry["is_valid"]:
            continue
        if entry["type"] == "start":
            pending_start = entry
        elif pending_start is not None:
            sessions.append(_make_session(pending_start, entry, book_title, book_ext))
            pending_start = None

    return sessions


def _make_session(start, end, book_title, book_ext):
    """Build one ClippingEntry from a paired start/end marker."""
    start_annotation = start["annotation"]
    end_annotation = end["annotation"]
    note_texts = [
        annotation.get("note", "")
        for annotation in (start_annotation, end_annotation)
        if annotation.get("note")
    ]

    entry = ClippingEntry(
        book_title=book_title,
        start_pid=start["position"],
        end_pid=end["position"],
        start_date=start["date"],
        end_date=end["date"],
        highlight_text=start_annotation.get("text", "") or "",
        highlight_date=start["date"],
        annotation_note="\n".join(note_texts) if note_texts else None,
    )
    entry.reader_ext = ".sdr"
    entry.book_extension = book_ext
    # KOReader's pos1 is the exclusive end of the highlight.
    entry.end_exclusive = True
    return entry


def _metadata_language(metadata):
    doc_props = metadata.get("doc_props")
    if isinstance(doc_props, dict):
        language = doc_props.get("language")
        if isinstance(language, str) and language:
            return language
    language = metadata.get("text_lang")
    return language if isinstance(language, str) and language else None


def extract_from_koreader_sdr(sdr_dir):
    """Extract reading sessions from a single KOReader ``.sdr`` directory."""
    metadata_path = find_koreader_metadata(sdr_dir)
    if metadata_path is None:
        return []

    try:
        metadata = load_lua_table(metadata_path)
    except Exception as error:
        print("Error decoding %s: %s" % (metadata_path, error))
        return []

    book_title = _book_title(sdr_dir)
    book_ext = _book_extension(metadata_path)
    markers = _collect_markers(_annotation_list(metadata))
    if not markers:
        return []

    sessions = _pair_markers(markers, book_title, book_ext)
    language = _metadata_language(metadata)
    for session in sessions:
        session.language = language
    return sessions
