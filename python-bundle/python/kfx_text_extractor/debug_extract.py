"""Diagnostic script for sidecar annotation extraction debugging."""
import sys
import os

# Prepend local package to path so we use local version, not installed
_here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _here not in sys.path:
    sys.path.insert(0, _here)

from kfx_text_extractor.sidecar_annotation_extractor import extract_from_sidecars
from kfx_text_extractor.book_matcher import match_book
from kfx_text_extractor.kfx_index import build_pid_index
from kfx_text_extractor.text_extractor import extract_text


def _extract_numeric_pid(pos):
    """Extract the numeric pid from a position string like 'PREFIX:NUMERIC'."""
    if isinstance(pos, int):
        return pos
    if not isinstance(pos, str):
        return None
    if ':' in pos:
        parts = pos.rsplit(':', 1)
        try:
            return int(parts[1])
        except (ValueError, IndexError):
            return None
    try:
        return int(pos)
    except (ValueError, TypeError):
        return None


def main():
    # 1. Extract from sidecars
    sidecar_dir = '.'
    sessions = extract_from_sidecars(sidecar_dir)
    print(f"Found {len(sessions)} sessions from sidecars")

    for i, s in enumerate(sessions[:3]):
        print(f"\n=== Session {i} ===")
        print(f"  start_pid={s.start_pid}, end_pid={s.end_pid}")
        print(f"  book={s.book_title}")

        # 2. Find KFX
        kfx_path = match_book(s.book_title, 'KFX+sidecar')
        if not kfx_path:
            print("  No KFX found!")
            continue
        print(f"  KFX: {kfx_path}")

        # 3. Build index
        index = build_pid_index(kfx_path)
        print(f"  total_pids={index.total_pids}")
        print(f"  pid_map size={len(index.pid_map)}")
        print(f"  pid_map keys: {sorted(index.pid_map.keys())}")

        for k in sorted(index.pid_map.keys()):
            end, text = index.pid_map[k]
            print(f"    pid [{k}..{end}] len={len(text)} preview={text[:40]}")

        # 4. Extract text
        start = _extract_numeric_pid(s.start_pid)
        end = _extract_numeric_pid(s.end_pid)
        if start is None or end is None:
            print(f"  Could not parse pids")
            continue

        try:
            result = extract_text(index, start, end)
            print(f"  extract_text result: len={len(result)} repr={repr(result[:100])}")
        except Exception as e:
            print(f"  extract_text error: {e}")


if __name__ == '__main__':
    main()
