"""Extract highlights and memos (Krs.start/Krs.end) from KRDS sidecar files.

Reads annotation.cache.object from decoded sidecar .json files (.azw3r for AZW3,
.yjr for KFX, .mbp1 for legacy MOBI) and pairs highlights with their associated
memo notes (Krs.start/Krs.end markers).

This mirrors the approach from example-scripts/scripts/export_annotations.py
but pairs Krs.start/Krs.end memos with their corresponding highlight ranges
to produce ClippingEntry-compatible results.
"""

import collections
import datetime
import glob
import io
import json
import logging
import os
import struct


# Mapping of annotation type IDs to names (from krds.py)
ANNOT_CLASS_NAMES = {
    0: "annotation.personal.bookmark",
    1: "annotation.personal.highlight",
    2: "annotation.personal.note",
    3: "annotation.personal.clip_article",
    10: "annotation.personal.handwritten_note",
    11: "annotation.personal.sticky_note",
    13: "annotation.personal.underline",
}

# Sidecar file extensions to look for
READER_EXTS = (".azw3r", ".yjr", ".mbp1")

# KRS marker patterns
KRS_START_MARKER = "Krs.start"
KRS_END_MARKER = "Krs.end"


def _timestamp_to_iso(ts):
    """Convert a millisecond timestamp to ISO 8601 format (matching krds.py)."""
    if ts in (0, -1):
        return None
    try:
        return datetime.datetime.fromtimestamp(ts / 1000.0).isoformat()
    except Exception:
        return None


class ClippingEntry:
    """A paired Krs.start/Krs.end reading session from sidecar annotations."""

    __slots__ = (
        "book_title",
        "start_pid",
        "end_pid",
        "start_date",
        "end_date",
        "highlight_text",
        "highlight_date",
        "annotation_note",
        "book_title_metadata",
        "language",
        "reader_ext",
    )

    def __init__(self, book_title, start_pid, end_pid, start_date, end_date,
                 highlight_text, highlight_date, annotation_note=None, reader_ext=None):
        self.book_title = book_title
        self.start_pid = start_pid
        self.end_pid = end_pid
        self.start_date = start_date
        self.end_date = end_date
        self.highlight_text = highlight_text
        self.highlight_date = highlight_date
        self.annotation_note = annotation_note
        # Optional fields populated from KFX metadata
        self.book_title_metadata = None
        self.language = None
        # Sidecar reader extension (e.g., '.yjr', '.azw3r', '.mbp1')
        self.reader_ext = reader_ext


def _strip_ext(name, exts):
    """Drop the sidecar extension from a filename (basename also carries device hash)."""
    for ext in exts:
        if ext in name:
            return name.rsplit(ext, 1)[0]
    return name


def _clean_title(path):
    """Extract a book title from a sidecar file path.

    Strips the device hash suffix and sidecar extension from the basename.
    """
    basename = os.path.basename(path)
    # Strip device hash (e.g. "7d1790cc") if present
    for part in basename.split("7d1790cc"):
        if len(part) < len(basename):
            basename = part
            break
    return _strip_ext(basename, READER_EXTS).strip(" -_")


def _find_sidecar_files(documents_dir):
    """Find all reader sidecar files in a directory tree."""
    files = []
    for ext in READER_EXTS:
        files.extend(glob.glob(os.path.join(documents_dir, "**", "*" + ext), recursive=True))
    return files


def _decode_krds(binary_data):
    """Decode a KRDS sidecar file from binary data to a dict.

    Port of krds.py's KindleReaderDataStore.deserialize() and decode logic.
    """
    krds = Deserializer(binary_data)
    signature = krds.extract(8)
    expected = b"\x00\x00\x00\x00\x00\x1A\xB1\x26"
    if signature != expected:
        raise Exception("KRDS signature is incorrect")

    first_value = _decode_next_value(krds)
    if first_value != 1:
        raise Exception("first_value = %s" % repr(first_value))

    value_cnt = _decode_next_value(krds)
    value = collections.OrderedDict()

    for _ in range(value_cnt):
        val = _decode_next_value(krds)
        for k, v in val.items():
            if k in value:
                raise Exception("KRDS has duplicate item %s" % k)
            value[k] = v

    return value


def _decode_next_value(krds):
    """Decode the next value from a KRDS stream."""
    datatype = krds.unpack("b")
    return _decode_value_from_type(krds, datatype)


def _decode_value_from_type(krds, datatype):
    """Decode a value given its KRDS datatype byte."""
    if datatype == 0:  # BOOLEAN
        b = krds.unpack("b")
        return False if b == 0 else True
    elif datatype == 1:  # INT
        return krds.unpack(">l")
    elif datatype == 2:  # LONG
        return krds.unpack(">q")
    elif datatype == 3:  # UTF
        if _decode_value_from_type(krds, 0):
            return ""
        return krds.extract(krds.unpack(">H")).decode("utf-8")
    elif datatype == 4:  # DOUBLE
        return krds.unpack(">d")
    elif datatype == 5:  # SHORT
        return krds.unpack(">h")
    elif datatype == 6:  # FLOAT
        return krds.unpack(">f")
    elif datatype == 7:  # BYTE
        return krds.unpack("b")
    elif datatype == 9:  # CHAR
        return krds.unpack("c").decode("utf-8")
    elif datatype == -2:  # OBJECT_BEGIN
        name = _decode_value_from_type(krds, 3)  # UTF
        val = []
        while krds.unpack("b", advance=False) != -1:  # OBJECT_END
            val.append(_decode_value_from_type(krds, krds.unpack("b")))
        krds.unpack("b")  # consume OBJECT_END
        return _decode_object(name, val)
    else:
        raise Exception("Unknown datatype %d" % datatype)


def _decode_object(name, val):
    """Decode a named KRDS object based on its structure type.
    
    Returns {name: decoded_obj} to match the reference krds.py decode_object() behavior.
    """
    raw = list(val)
    try:
        obj = {}
        if name in (
            "clock.data.store", "dictionary", "lpu", "pdf.contrast", "sync_lpr",
            "tpz.line.spacing", "XRAY_OTA_UPDATE_STATE", "XRAY_SHOWING_SPOILERS",
            "XRAY_SORTING_STATE", "XRAY_TAB_STATE"
        ):
            obj = val.pop(0)
        elif name in ("dict.prefs.v2", "EndActions", "ReaderMetrics", "StartActions",
                       "Translator", "Wikipedia"):
            for _ in range(val.pop(0)):
                k = val.pop(0)
                obj[k] = val.pop(0)
        elif name in ("buy.asin.response.data", "next.in.series.info.data", "price.info.data"):
            obj = val.pop(0)
        elif name == "annotation.cache.object":
            obj = _decode_annotation_cache(val)
        elif name == "saved.avl.interval.tree":
            # Reference: obj = [val.pop(0) for _ in range(val.pop(0))]
            count = val.pop(0) if val else 0
            obj = [val.pop(0) for _ in range(count)]
        elif name in ANNOT_CLASS_NAMES.values():
            # Decodes annotation.personal.highlight, annotation.personal.note, etc.
            obj["startPosition"] = val.pop(0) if val else ""
            obj["endPosition"] = val.pop(0) if val else ""
            creation_ts = val.pop(0) if val else 0
            obj["creationTime"] = _timestamp_to_iso(creation_ts)
            modification_ts = val.pop(0) if val else 0
            obj["lastModificationTime"] = _timestamp_to_iso(modification_ts)
            obj["template"] = val.pop(0) if val else ""
            if name == "annotation.personal.note":
                obj["note"] = val.pop(0) if val else ""
            elif name == "annotation.personal.handwritten_note":
                obj["handwritten_note_nbk_ref"] = val.pop(0) if val else ""
            elif name == "annotation.personal.sticky_note":
                obj["sticky_note_nbk_ref"] = val.pop(0) if val else ""
        elif name == "font.prefs":
            for key in ("typeface", "lineSp", "size", "align", "insetTop", "insetLeft",
                        "insetBottom", "insetRight"):
                obj[key] = val.pop(0) if val else None
        elif name == "book.info.store":
            obj["numberOfWords"] = val.pop(0) if val else None
            obj["percentOfBook"] = val.pop(0) if val else None
        elif name == "page.history.store":
            obj = val
        elif name == "timer.model":
            obj["version"] = val.pop(0) if val else None
            obj["totalTime"] = val.pop(0) if val else None
            obj["totalWords"] = val.pop(0) if val else None
            obj["totalPercent"] = val.pop(0) if val else None
        else:
            obj = raw if len(val) else {}
        return {name: obj}
    except Exception:
        return {name: raw}


def _decode_annotation_cache(val):
    """Decode the annotation.cache.object structure.
    
    Matches reference krds.py line 217-231: iterates count, then for each
    annotation type, reads the saved.avl.interval.tree and extracts the
    annotation data by class name.
    """
    result = {}
    item_count = val.pop(0) if val else 0
    for _ in range(item_count):
        annotation_type = val.pop(0) if val else None
        annot_class_name = ANNOT_CLASS_NAMES.get(annotation_type)
        if annot_class_name is None:
            raise Exception("Unknown annotation type %d" % annotation_type)

        annotations = []
        tree_data = val.pop(0) if val else {}
        for annotation in tree_data.get("saved.avl.interval.tree", []):
            if len(annotation) != 1 or annot_class_name not in annotation:
                raise Exception("Unknown annotation format: %s" % repr(annotation))
            annotations.append(annotation[annot_class_name])

        result[annot_class_name] = annotations
    return result


def _decode_single_annotation(annotation, annot_class_name):
    """Decode a single annotation from the interval tree."""
    results = []
    for item in annotation:
        if isinstance(item, dict) and annot_class_name in item:
            annot_data = item[annot_class_name]
            entry = {
                "type": annot_class_name,
                "startPosition": annot_data.get("startPosition", ""),
                "endPosition": annot_data.get("endPosition", ""),
                "creationTime": annot_data.get("creationTime", ""),
                "lastModificationTime": annot_data.get("lastModificationTime", ""),
                "template": annot_data.get("template", ""),
            }
            if "note" in annot_data:
                entry["note"] = annot_data["note"]
            elif "handwritten_note_nbk_ref" in annot_data:
                entry["handwritten_note_nbk_ref"] = annot_data["handwritten_note_nbk_ref"]
            elif "sticky_note_nbk_ref" in annot_data:
                entry["sticky_note_nbk_ref"] = annot_data["sticky_note_nbk_ref"]
            results.append(entry)
    return results


def _decode_json_sidecar(filepath):
    """Load and parse a pre-decoded sidecar JSON file."""
    with open(filepath, 'r', encoding='utf-8') as f:
        return json.load(f)




def _extract_krs_pairs_from_sidecar(sidecar_data, book_title):
    """Extract Krs.start/Krs.end paired entries from a single sidecar's annotation data.

    Algorithm:
    1. List all highlights as position ranges
    2. Collect ALL Krs notes into one unified list, sorted by creationTime
    3. For each Krs note: Find nearest highlight by position proximity
       - If Krs.start -> use highlight's startPosition
       - If Krs.end -> use highlight's endPosition
    4. Validate sequence: if two Krs.start in a row, keep second & warn about first;
       if two Krs.end in a row, keep first & warn about second
    5. Pair consecutive valid (start, end) entries into reading sessions
    """
    cache = sidecar_data.get("annotation.cache.object")
    if not cache or not isinstance(cache, dict):
        print(f"Warning: No annotation.cache.object found in sidecar for '{book_title}'")
        return []

    highlights = cache.get("annotation.personal.highlight", []) or []
    notes = cache.get("annotation.personal.note", []) or []

    # Step 1: Build list of position ranges from highlights
    ranges = []
    for hl in highlights:
        if isinstance(hl, dict):
            start_pos = hl.get("startPosition", "")
            end_pos = hl.get("endPosition", "")
            created = hl.get("creationTime", "")
            if start_pos and end_pos:
                ranges.append({
                    "start_position": start_pos,
                    "end_position": end_pos,
                    "creation_time": created,
                })

    # Step 2: Collect ALL Krs notes into a single list
    krs_notes = []
    for note in notes:
        if not isinstance(note, dict):
            continue
        note_text = note.get("note", "")
        if KRS_START_MARKER.lower() in note_text.lower() or KRS_END_MARKER.lower() in note_text.lower():
            krs_notes.append(note)

    # Sort by creationTime (parse as datetime for comparison)
    def parse_creation_time(note):
        """Parse creation time string for sorting."""
        creation_time = note.get("creationTime", "")
        if not creation_time:
            return datetime.datetime.min
        try:
            for fmt in ("%Y-%m-%dT%H:%M:%S.%f", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y/%m/%d %H:%M:%S"):
                try:
                    return datetime.datetime.strptime(creation_time, fmt)
                except ValueError:
                    continue
            return datetime.datetime.min
        except Exception:
            return datetime.datetime.min

    krs_notes.sort(key=parse_creation_time)

    # Step 3: Find nearest highlight for each Krs note, extract position
    def find_nearest_highlight(note):
        """Find the nearest highlight range to a note by position proximity."""
        if not ranges:
            return None
        note_start = note.get("startPosition", "")
        note_end = note.get("endPosition", "")
        
        best_range = None
        best_dist = float('inf')
        
        for rng in ranges:
            dist = _position_distance(note_start, note_end, rng["start_position"], rng["end_position"])
            if dist < best_dist:
                best_dist = dist
                best_range = rng
        
        return best_range

    # Build validated, processed Krs entries
    # Each entry: {'type': 'start'/'end', 'note': dict, 'position': str, 'is_valid': bool}
    processed_entries = []
    
    for i, note in enumerate(krs_notes):
        is_start = KRS_START_MARKER.lower() in note.get("note", "").lower()
        note_type = "start" if is_start else "end"
        
        # Find nearest highlight and extract appropriate position
        nearest = find_nearest_highlight(note)
        if is_start and nearest:
            position = nearest["start_position"]
        elif not is_start and nearest:
            position = nearest["end_position"]
        else:
            position = note.get("startPosition", "") if is_start else note.get("endPosition", "")
        
        processed_entries.append({
            "type": note_type,
            "note": note,
            "position": position,
            "is_valid": True,  # Will be updated by validation pass
        })
    
    # Step 4: Validate sequence - detect consecutive same-type markers
    for i in range(len(processed_entries)):
        curr = processed_entries[i]
        prev = processed_entries[i - 1] if i > 0 else None
        
        if prev is None:
            continue
        
        if curr["type"] == "start" and prev["type"] == "start":
            # Two Krs.start in a row: keep second (current), warn about first (previous)
            processed_entries[i - 1]["is_valid"] = False
            logging.warning(
                "Book '%s': Consecutive Krs.start at position/indices %s %d and %s %d - invalidating index %s %d, keeping index %s %d",
                book_title, prev["position"], i - 1, curr["position"], i, prev["position"], i - 1, curr["position"], i
            )
        
        elif curr["type"] == "end" and prev["type"] == "end":
            # Two Krs.end in a row: keep first (previous), warn about second (current)
            processed_entries[i]["is_valid"] = False
            logging.warning(
                "Book '%s': Consecutive Krs.end at position/indices %s %d and %s %d - invalidating index %s %d, keeping index %s %d",
                book_title, prev["position"], i - 1, curr["position"], i, curr["position"], i, prev["position"], i - 1
            )
    
    # Step 5: Pair consecutive valid (start, end) entries
    entries = []
    valid_starts = []
    valid_ends = []
    
    for entry in processed_entries:
        if entry["is_valid"]:
            if entry["type"] == "start":
                valid_starts.append(entry)
            elif entry["type"] == "end":
                valid_ends.append(entry)
    
    # Pair them 1:1 sequentially
    min_count = min(len(valid_starts), len(valid_ends))
    for i in range(min_count):
        start_entry = valid_starts[i]
        end_entry = valid_ends[i]
        start_note = start_entry["note"]
        end_note = end_entry["note"]
        
        start_date = start_note.get("creationTime", "")
        end_date = end_note.get("creationTime", "")
        highlight_date = ""
        
        # Combine note texts
        note_texts = []
        if start_note:
            note_texts.append(start_note.get("note", ""))
        if end_note:
            note_texts.append(end_note.get("note", ""))
        annotation_note = "\n".join(note_texts) if note_texts else None
        
        clipping = ClippingEntry(
            book_title=book_title,
            start_pid=start_entry["position"],
            end_pid=end_entry["position"],
            start_date=start_date,
            end_date=end_date,
            highlight_text="",
            highlight_date=highlight_date,
            annotation_note=annotation_note,
        )
        entries.append(clipping)

    return entries


def _position_distance(start1, end1, start2, end2):
    """Calculate distance between two position ranges.

    For KFX positions (format: "PREFIX:NUMERIC"), uses the numeric suffix.
    For other formats, uses string distance as fallback.
    """
    def extract_num(pos):
        """Extract the numeric portion from a position string."""
        if isinstance(pos, int):
            return pos
        if not isinstance(pos, str):
            return 0
        if ":" in pos:
            parts = pos.rsplit(":", 1)
            try:
                return int(parts[1])
            except (ValueError, IndexError):
                return 0
        try:
            return int(pos)
        except (ValueError, TypeError):
            return 0

    num1_end = extract_num(end1)
    num2_end = extract_num(end2)
    num1_start = extract_num(start1)
    num2_start = extract_num(start2)

    return abs(num1_end - num2_start) + abs(num2_end - num1_start)


def extract_from_sidecars(documents_dir, max_books=None):
    """Extract Krs.start/Krs.end paired entries from sidecar files.

    Args:
        documents_dir: Path to the directory containing .sdr/ folders or sidecar files.
        max_books: Optional limit on number of books to process (for testing).

    Returns:
        List of ClippingEntry for all valid Krs.start/Krs.end pairs found.
    """
    all_entries = []

    # Check if documents_dir contains .sdr/ folders directly (sidecar directory mode)
    if ".sdr" in os.path.basename(documents_dir).lower():
        # Mode: documents_dir IS a sidecar directory
        entries = _extract_from_sdr_directory(documents_dir)
        return entries
    
    # Mode: documents_dir contains multiple .sdr/ folders
    sdr_dirs = []
    for root, dirs, files in os.walk(documents_dir):
        for d in dirs:
            if ".sdr" in d.lower():
                sdr_dirs.append(os.path.join(root, d))
    
    for sdr_dir in sdr_dirs:
        if max_books and len(all_entries) >= max_books:
            break
        entries = _extract_from_sdr_directory(sdr_dir)
        all_entries.extend(entries)

    return all_entries


class Deserializer:
    """Minimal KRDS binary deserializer."""

    def __init__(self, data):
        self.buffer = data
        self.offset = 0

    def unpack(self, fmt, advance=True):
        result = struct.unpack_from(fmt, self.buffer, self.offset)[0]
        if advance:
            self.offset += struct.calcsize(fmt)
        return result

    def extract(self, size=None, upto=None, advance=True):
        if size is None:
            size = len(self) if upto is None else (upto - self.offset)
        data = self.buffer[self.offset:self.offset + size]
        if len(data) < size or size < 0:
            raise Exception("Deserializer: Insufficient data (need %d bytes, have %d bytes)" % (size, len(data)))
        if advance:
            self.offset += size
        return data

    def __len__(self):
        return len(self.buffer) - self.offset


def _extract_from_sdr_directory(sdr_dir):
    """Extract entries from a single .sdr/ directory.

    Decodes binary sidecar files directly in memory (no JSON file dependency)
    and extracts KRS pairs from them.
    Deduplicates by start_pid/end_pid pair to avoid processing both .yjr and .yjf
    sidecar files that share the same annotation data.
    """
    all_entries = []
    seen_pairs = set()
    book_title = _clean_title(sdr_dir)
    reader_ext: str | None = None

    # Collect all binary sidecar files and decode them in memory
    processed_bases = set()

    for ext in READER_EXTS:
        for filepath in glob.glob(os.path.join(sdr_dir, "*" + ext)):
            basename = os.path.basename(filepath)
            # Strip extension to get base name for deduplication
            base = os.path.splitext(basename)[0]
            
            if base in processed_bases:
                continue
            processed_bases.add(base)
            
            # Track which reader extension we found (first one wins)
            if reader_ext is None:
                reader_ext = ext
            
            # Decode the binary data directly in memory
            try:
                with open(filepath, 'rb') as f:
                    binary_data = f.read()
                sidecar_data = _decode_krds(binary_data)
            except Exception as e:
                print(f"Error decoding {filepath}: {e}")
                continue
            
            if sidecar_data is None:
                continue

            entries = _extract_krs_pairs_from_sidecar(sidecar_data, book_title)
            for entry in entries:
                # Deduplicate by (start_pid, end_pid) pair
                pair_key = (entry.start_pid, entry.end_pid)
                if pair_key not in seen_pairs:
                    seen_pairs.add(pair_key)
                    all_entries.append(entry)

    # Attach reader_ext to all entries
    for entry in all_entries:
        entry.reader_ext = reader_ext

    return all_entries


def list_valid_sidecars(documents_dir, max_books=None):
    """List sidecar filenames that contain valid Krs.start/Krs.end pairs.

    Scans the given directory tree for .sdr/ folders (or sidecar files directly)
    and returns a list of sidecar directory/file paths that contain at least one
    valid Krs.start/Krs.end pair.

    Args:
        documents_dir: Path to the directory containing .sdr/ folders or sidecar files.
        max_books: Optional limit on number of books to process (for testing).

    Returns:
        List of sidecar file/directory paths with valid Krs.start/Krs.end pairs.
    """
    valid_sidecars = []

    # Check if documents_dir is itself a sidecar directory (e.g., .sdr/ folder)
    if ".sdr" in os.path.basename(documents_dir).lower():
        # Single sidecar directory mode
        book_title = _clean_title(documents_dir)
        # Collect all binary sidecar files
        for ext in READER_EXTS:
            for filepath in glob.glob(os.path.join(documents_dir, "*" + ext)):
                try:
                    with open(filepath, 'rb') as f:
                        binary_data = f.read()
                    sidecar_data = _decode_krds(binary_data)
                    entries = _extract_krs_pairs_from_sidecar(sidecar_data, book_title)
                    if entries:
                        if documents_dir not in valid_sidecars:
                            valid_sidecars.append(documents_dir)
                        break
                except Exception:
                    continue
        return valid_sidecars

    # Mode: documents_dir contains multiple .sdr/ folders
    count = 0
    for root, dirs, files in os.walk(documents_dir):
        for d in dirs:
            if ".sdr" in d.lower():
                sdr_dir = os.path.join(root, d)
                if max_books and count >= max_books:
                    break
                count += 1
                book_title = _clean_title(sdr_dir)
                # Collect all binary sidecar files
                for ext in READER_EXTS:
                    for filepath in glob.glob(os.path.join(sdr_dir, "*" + ext)):
                        try:
                            with open(filepath, 'rb') as f:
                                binary_data = f.read()
                            sidecar_data = _decode_krds(binary_data)
                            entries = _extract_krs_pairs_from_sidecar(sidecar_data, book_title)
                            if entries:
                                if sdr_dir not in valid_sidecars:
                                    valid_sidecars.append(sdr_dir)
                            break
                        except Exception as e:
                            print(f"Error decoding {filepath}: {e}")
                            continue
        if max_books and count >= max_books:
            break

    return valid_sidecars
