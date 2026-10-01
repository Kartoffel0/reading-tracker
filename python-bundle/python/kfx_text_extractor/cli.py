"""CLI entry point for KFX text extraction from sidecar annotations."""

import argparse
import os
import sys
from pathlib import Path
from typing import Optional

from .sidecar_annotation_extractor import extract_from_sidecars, list_valid_sidecars
from .book_matcher import find_matching_book, extract_book_info
from .kfx_index import build_pid_index
from .text_extractor import extract_text
from .csv_exporter import export_sessions, export_sessions_to_dicts, DEFAULT_COLUMNS


def _extract_numeric_pid(pos) -> Optional[int]:
    """Extract the numeric pid from a position string like 'PREFIX:NUMERIC'.

    For sidecar annotations, positions are stored as strings (e.g., 'AT0RAAABAAAA:47380').
    The KFX file uses integer pids, so we extract the numeric suffix.
    """
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


def _build_parser():
    """Build and return the CLI argument parser."""
    parser = argparse.ArgumentParser(
        prog='kfx-extract',
        description='Extract highlighted text from KFX books using sidecar annotations'
    )

    parser.add_argument('input_path', nargs='?', default='.',
                        help='Path to a single .sdr/ directory or documents directory to scan for sidecar files')
    parser.add_argument('-o', '--output', default=None,
                        help='Output CSV file path. If omitted, returns JSON instead of writing a file.')
    parser.add_argument('--max-books', type=int, default=None,
                        help='Limit number of books to process')
    parser.add_argument('--columns', type=str, default=None,
                        help=f'Comma-separated list of CSV columns to output. Default: {",".join(DEFAULT_COLUMNS)}')
    parser.add_argument('--timezone', type=str, default='UTC',
                        help='Timezone for date output (default: UTC). Examples: America/Sao_Paulo, Europe/London')
    parser.add_argument('--no-time', action='store_true', default=False,
                        help='Output only dates (YYYY-MM-DD) for start_date/end_date, without time component')
    parser.add_argument('--scan-only', action='store_true', default=False,
                        help='Only scan and list sidecar files containing valid Krs.start/Krs.end pairs, without full processing')
    parser.add_argument('--book-folder', type=str, default=None,
                        help='Directory to search for book files (KFX/AZW3/MOBI). '
                             'Searches here first, then sidecar directory, then parent directory.')
    return parser


def run_scan_only(sidecar_dir: str = '.', max_books: int | None = None) -> list[str]:
    """Run scan-only mode: list sidecars with valid Krs.start/Krs.end pairs.

    This is the public, importable version of --scan-only.

    Args:
        sidecar_dir: Path to the directory containing .sdr/ folders or sidecar files.
        max_books: Optional limit on number of books to process.

    Returns:
        List of sidecar directory paths with valid Krs.start/Krs.end pairs.
    """
    print(f"Scanning sidecars in: {sidecar_dir}")
    valid_sidecars = list_valid_sidecars(sidecar_dir, max_books=max_books)

    print(f"\nFound {len(valid_sidecars)} sidecar(s) with valid Krs.start/Krs.end pairs:")
    for sdr_path in valid_sidecars:
        print(f"  - {sdr_path}")

    return valid_sidecars


def run_sidecar_mode(
    sidecar_dir: str = '.',
    output: str | None = None,
    max_books: int | None = None,
    columns: list[str] | None = None,
    timezone: str = 'UTC',
    include_time: bool = True,
    book_folder: str | None = None,
) -> list | dict:
    """Run the full sidecar extraction pipeline.

    This is the public, importable version of the main CLI flow.

    Args:
        sidecar_dir: Path to the directory containing .sdr/ folders or sidecar files.
        output: Output CSV file path. If None, returns JSON-serializable dict instead.
        max_books: Optional limit on number of books to process.
        columns: Optional list of CSV columns to output.
        timezone: Timezone string for date output.
        include_time: Whether to include time component in dates.
        book_folder: Optional directory to search for book files first.

    Returns:
        If output is None: a dict with 'sessions' (list[dict]) and 'stats' (dict).
        If output is provided: writes CSV file and returns the sessions list.
    """
    # Extract from sidecars
    print(f"Scanning sidecars in: {sidecar_dir}")
    sessions = extract_from_sidecars(sidecar_dir, max_books=max_books)
    print(f"Found {len(sessions)} Krs.start/Krs.end pairs from sidecar annotations")

    if not sessions:
        print("No Krs.start/Krs.end pairs found in sidecar annotations. Exiting.")
        sys.exit(0)

    # Build annotation notes dict for export
    annotation_notes = {}
    for i, session in enumerate(sessions):
        note = getattr(session, 'annotation_note', None)
        if note:
            annotation_notes[i] = note

    # Process each session for text extraction and metadata
    extracted_data = {}
    book_info_cache = {}

    for i, session in enumerate(sessions):
        print(f"[{i+1}/{len(sessions)}] Processing: {session.book_title[:50]}...")

        # Find matching book file using reader_ext from the sidecar
        book_path = find_matching_book(
            title=session.book_title,
            reader_ext=session.reader_ext or ".yjr",
            book_folder=book_folder,
            sidecar_dir=sidecar_dir,
        )
        if book_path is None:
            print(f"  Warning: No book file found for '{session.book_title}'")
            continue

        print(f"  Found book: {book_path}")

        # Extract book metadata (cached by path)
        book_info = None
        if book_path not in book_info_cache:
            try:
                book_info = extract_book_info(book_path)
                book_info_cache[book_path] = book_info
            except Exception as e:
                print(f"  Warning: Failed to extract metadata from {book_path}: {e}")
                book_info_cache[book_path] = None
        else:
            book_info = book_info_cache[book_path]

        if book_info:
            # Enrich session with metadata
            session.book_title_metadata = book_info.book_title
            session.language = book_info.language

        # Build text index
        try:
            index = build_pid_index(book_path)
            print(f"  Built index: {index.total_pids} pids, {len(index.pid_map)} chunks")
        except Exception as e:
            print(f"  Error building index: {e}")
            continue

        # Extract numeric pids for text extraction
        start_int = _extract_numeric_pid(session.start_pid)
        end_int = _extract_numeric_pid(session.end_pid)
        if start_int is None or end_int is None:
            print(f"  Warning: Could not parse pids ({session.start_pid}, {session.end_pid})")
            continue

        # Extract text
        try:
            extracted = extract_text(index, start_int, end_int)
            print(f"  Extracted {len(extracted)} characters")
            extracted_data[i] = {'text': extracted, 'count': len(extracted)}
        except Exception as e:
            print(f"  Error extracting text: {e}")
            extracted_data[i] = {'text': '', 'count': 0}

    # Conditionally return JSON or write CSV
    if output is None:
        # Return JSON-serializable dict
        session_dicts = export_sessions_to_dicts(
            sessions,
            columns=columns,
            extracted_texts=extracted_data,
            annotation_notes=annotation_notes,
            timezone_str=timezone,
            include_time=include_time,
        )
        result = {
            "sessions": session_dicts,
            "stats": {
                "sidecarsPulled": len(set(s.book_title for s in sessions)),
                "sessionsExtracted": len(session_dicts),
            }
        }
        print(f"\nReturning {len(session_dicts)} sessions as JSON")
        return result

    # Export to CSV
    print(f"\nExporting {len(sessions)} sessions to: {output}")
    export_sessions(
        sessions,
        output,
        columns=columns,
        extracted_texts=extracted_data,
        annotation_notes=annotation_notes,
        timezone_str=timezone,
        include_time=include_time,
    )

    print("Done!")
    return sessions


def _run_scan_only_mode(args):
    """Run scan-only mode from CLI args (kept for compatibility with main())."""
    return run_scan_only(
        sidecar_dir=args.input_path if args.input_path else '.',
        max_books=args.max_books,
    )


def _run_sidecar_mode_from_args(args):
    """Run full mode from CLI args (kept for compatibility with main())."""
    # Parse columns if provided as comma-separated string
    columns = None
    if args.columns:
        columns = [c.strip() for c in args.columns.split(',')]

    run_sidecar_mode(
        sidecar_dir=args.input_path if args.input_path else '.',
        output=args.output,
        max_books=args.max_books,
        columns=columns,
        timezone=args.timezone,
        include_time=not args.no_time,
        book_folder=args.book_folder,
    )


def main():
    """CLI entry point. Parses args and dispatches to the appropriate mode."""
    parser = _build_parser()
    args = parser.parse_args()

    if args.scan_only:
        _run_scan_only_mode(args)
        return

    _run_sidecar_mode_from_args(args)


if __name__ == '__main__':
    main()
