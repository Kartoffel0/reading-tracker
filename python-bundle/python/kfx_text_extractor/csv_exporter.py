"""Export reading sessions to CSV format."""

import csv
import zoneinfo
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import List, Optional

# Import from sidecar module since clipping_parser is removed
from .sidecar_annotation_extractor import ClippingEntry


# Default columns in order
DEFAULT_COLUMNS = [
    'book_title',
    'start_pid',
    'end_pid',
    'start_date',
    'end_date',
    'session_date',
    'session_duration',
    'extracted_text',
    'char_count',
    'language',
]

# All supported columns (any subset can be requested)
SUPPORTED_COLUMNS = set(DEFAULT_COLUMNS)

# Timezone defaults
DEFAULT_TIMEZONE = 'UTC'
DEFAULT_TIME_FORMAT = '%Y-%m-%dT%H:%M:%S%z'
DATE_ONLY_FORMAT = '%Y-%m-%d'

# Offset to use when session spans midnight and end is before 4am
SESSION_ADJUSTMENT_HOURS = 4


def _load_timezone(tz_str: str):
    """Load a timezone by name, with fallback to UTC.
    
    Handles special cases like 'UTC' on Windows where tzdata may not be installed.
    """
    if tz_str.upper() == 'UTC':
        return timezone.utc
    
    try:
        return zoneinfo.ZoneInfo(tz_str)
    except Exception:
        # Fallback for unknown timezones or missing tzdata on any platform
        return timezone.utc


def _format_datetime(dt: datetime, include_time: bool = True) -> str:
    """Format a datetime to string.
    
    Args:
        dt: datetime to format
        include_time: if True, include time component (YYYY-MM-DDTHH:MM:SS+HH:MM)
                     if False, date only (YYYY-MM-DD)
    
    Returns:
        Formatted datetime string
    """
    if include_time:
        return dt.strftime(DATE_ONLY_FORMAT) + dt.strftime('T%H:%M:%S%z')
    return dt.strftime(DATE_ONLY_FORMAT)


def _adjust_session_date(end_date: datetime, start_date: datetime) -> datetime:
    """Calculate adjusted session date.
    
    If the session spanned midnight (start date != end date) AND end_date's
    wall-clock time is before SESSION_ADJUSTMENT_HOURS (default 4am),
    the session is considered to have ended on the previous day.
    
    Args:
        end_date: timezone-aware datetime for end of session
        start_date: timezone-aware datetime for start of session
    
    Returns:
        Adjusted end_date as a date
    """
    adj_date = end_date.date()
    
    # Check if session spanned midnight
    if start_date.date() != end_date.date():
        # Check if end time is before the adjustment threshold
        if end_date.time() < datetime.strptime(
            f"{SESSION_ADJUSTMENT_HOURS}:00:00", '%H:%M:%S'
        ).time() if end_date.tzinfo is not None else False:
            adj_date = end_date.date() - timedelta(days=1)
    
    return adj_date


def export_sessions(
    sessions: List[ClippingEntry],
    output_path: str,
    columns: Optional[List[str]] = None,
    extracted_texts: Optional[dict] = None,
    annotation_notes: Optional[dict] = None,
    timezone_str: str = DEFAULT_TIMEZONE,
    include_time: bool = True,
) -> None:
    """Export reading sessions to a CSV file.

    Args:
        sessions: List of ClippingEntry to export
        output_path: Path to the output CSV file
        columns: List of column names to include. If None, uses DEFAULT_COLUMNS.
        extracted_texts: Optional dict mapping session index to extracted text data
        annotation_notes: Optional dict mapping session index to annotation note text
        timezone_str: Timezone string for date output (e.g. 'UTC', 'America/Sao_Paulo').
                      Defaults to UTC.
        include_time: If True, include time component in start_date/end_date
                      (YYYY-MM-DDTHH:MM:SS+HH:MM). If False, date only (YYYY-MM-DD).
    """
    if columns is None:
        columns = DEFAULT_COLUMNS

    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)

    # Get the target timezone
    tz = _load_timezone(timezone_str)

    with open(output, 'w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=columns)
        writer.writeheader()

        for i, session in enumerate(sessions):
            row = {}

            for col in columns:
                if col == 'book_title':
                    # Use metadata title if available, otherwise use sidecar-derived title
                    val = getattr(session, 'book_title_metadata', None) or session.book_title
                    row['book_title'] = val

                elif col == 'start_pid':
                    row['start_pid'] = session.start_pid

                elif col == 'end_pid':
                    row['end_pid'] = session.end_pid

                elif col == 'start_date':
                    row['start_date'] = _format_column_start_end(
                        session.start_date, tz, include_time
                    )

                elif col == 'end_date':
                    row['end_date'] = _format_column_start_end(
                        session.end_date, tz, include_time
                    )

                elif col == 'session_date':
                    row['session_date'] = _format_column_session_date(
                        session.start_date, session.end_date, tz
                    )

                elif col == 'session_duration':
                    row['session_duration'] = _format_column_session_duration(
                        session.start_date, session.end_date, tz
                    )

                elif col == 'extracted_text':
                    row['extracted_text'] = ''
                    if extracted_texts and i in extracted_texts:
                        row['extracted_text'] = extracted_texts[i].get('text', '')

                elif col == 'char_count':
                    row['char_count'] = 0
                    if extracted_texts and i in extracted_texts:
                        row['char_count'] = extracted_texts[i].get('count', 0)

                elif col == 'language':
                    val = getattr(session, 'language', None) or getattr(session, 'language', '')
                    row['language'] = val if val else ''

                elif col == 'annotation_note':
                    row['annotation_note'] = getattr(session, 'annotation_note', '') or ''
                    if annotation_notes and i in annotation_notes:
                        row['annotation_note'] = annotation_notes[i]

                else:
                    # Unknown column, skip
                    row[col] = ''

            writer.writerow(row)


def _parse_date_to_aware(date_str: Optional[str], tz) -> Optional[datetime]:
    """Parse a date string from sidecar annotations to a timezone-aware datetime.
    
    Sidecar dates come as ISO format strings that represent UTC timestamps
    converted via datetime.fromtimestamp() (local time of the machine that created them).
    
    Args:
        date_str: ISO format date string (may include time, may be None)
        tz: target timezone
    
    Returns:
        Timezone-aware datetime or None
    """
    if date_str is None:
        return None
    
    try:
        dt = datetime.fromisoformat(date_str)
        
        # If the parsed datetime has no timezone info, assume it was in UTC
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        
        # Convert to target timezone
        dt = dt.astimezone(tz)
        return dt
    except (ValueError, TypeError, OSError):
        return None


def _format_column_start_end(date_str: Optional[str], tz, include_time: bool) -> str:
    """Format start_date or end_date column."""
    dt = _parse_date_to_aware(date_str, tz)
    if dt is None:
        return ''
    return _format_datetime(dt, include_time)


def _format_column_session_date(start_str: Optional[str], end_str: Optional[str], tz) -> str:
    """Format session_date column."""
    start_dt = _parse_date_to_aware(start_str, tz)
    end_dt = _parse_date_to_aware(end_str, tz)
    
    if start_dt is None or end_dt is None:
        return ''
    
    adj_date = _adjust_session_date(end_dt, start_dt)
    return adj_date.strftime(DATE_ONLY_FORMAT)


def _format_column_session_duration(start_str: Optional[str], end_str: Optional[str], tz) -> str:
    """Format session_duration column (in integer minutes)."""
    start_dt = _parse_date_to_aware(start_str, tz)
    end_dt = _parse_date_to_aware(end_str, tz)
    
    if start_dt is None or end_dt is None:
        return ''
    
    delta = end_dt - start_dt
    duration_minutes = int(delta.total_seconds() // 60)
    return str(duration_minutes)


def export_sessions_to_dicts(
    sessions: List[ClippingEntry],
    columns: Optional[List[str]] = None,
    extracted_texts: Optional[dict] = None,
    annotation_notes: Optional[dict] = None,
    timezone_str: str = DEFAULT_TIMEZONE,
    include_time: bool = True,
) -> List[dict]:
    """Export reading sessions to a list of dicts (JSON-serializable).

    Args:
        sessions: List of ClippingEntry to export
        columns: List of column names to include. If None, uses DEFAULT_COLUMNS.
        extracted_texts: Optional dict mapping session index to extracted text data
        annotation_notes: Optional dict mapping session index to annotation note text
        timezone_str: Timezone string for date output (e.g. 'UTC', 'America/Sao_Paulo').
        include_time: If True, include time component in start_date/end_date.

    Returns:
        List of dicts, one per session, containing only the requested columns.
    """
    if columns is None:
        columns = DEFAULT_COLUMNS

    tz = _load_timezone(timezone_str)
    result = []

    for i, session in enumerate(sessions):
        row = {}

        for col in columns:
            if col == 'book_title':
                val = getattr(session, 'book_title_metadata', None) or session.book_title
                row['book_title'] = val

            elif col == 'start_pid':
                row['start_pid'] = session.start_pid

            elif col == 'end_pid':
                row['end_pid'] = session.end_pid

            elif col == 'start_date':
                row['start_date'] = _format_column_start_end(
                    session.start_date, tz, include_time
                )

            elif col == 'end_date':
                row['end_date'] = _format_column_start_end(
                    session.end_date, tz, include_time
                )

            elif col == 'session_date':
                row['session_date'] = _format_column_session_date(
                    session.start_date, session.end_date, tz
                )

            elif col == 'session_duration':
                row['session_duration'] = _format_column_session_duration(
                    session.start_date, session.end_date, tz
                )

            elif col == 'extracted_text':
                row['extracted_text'] = ''
                if extracted_texts and i in extracted_texts:
                    row['extracted_text'] = extracted_texts[i].get('text', '')

            elif col == 'char_count':
                row['char_count'] = 0
                if extracted_texts and i in extracted_texts:
                    row['char_count'] = extracted_texts[i].get('count', 0)

            elif col == 'language':
                val = getattr(session, 'language', None) or getattr(session, 'language', '')
                row['language'] = val if val else ''

            elif col == 'annotation_note':
                row['annotation_note'] = getattr(session, 'annotation_note', '') or ''
                if annotation_notes and i in annotation_notes:
                    row['annotation_note'] = annotation_notes[i]

            else:
                row[col] = ''

        result.append(row)

    return result
