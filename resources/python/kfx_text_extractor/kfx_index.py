"""Build a pid-to-text index from a KFX book file."""

import sys
from dataclasses import dataclass

from .kfxlib import YJ_Book

@dataclass
class PidIndex:
    """A mapping of KFX pid values to text content.

    pid_map: dict mapping pid (start of text chunk) -> (pid_end, text)
    total_pids: total number of pids in the book
    """
    pid_map: dict[int, tuple[int, str]]
    total_pids: int


def build_pid_index(kfx_path: str) -> PidIndex:
    """Build a pid-to-text index from a KFX book using collect_content_position_info().

    Uses the existing kfxlib BookPosLoc.collect_content_position_info() method
    which correctly walks the KFX content tree and tracks cumulative pid values.

    Args:
        kfx_path: Path to the KFX file

    Returns:
        PidIndex containing the pid-to-text mapping
    """
    book = YJ_Book(kfx_path)
    book.decode_book(skip_book_checks=True)

    # Use the existing kfxlib method that correctly builds ContentChunk objects
    # with proper pid values and text content
    chunks = book.collect_content_position_info()

    # Build the pid_map from ContentChunk objects
    pid_map = {}
    total_pids = 0

    for chunk in chunks:
        if chunk.text is not None and len(chunk.text) > 0:
            # chunk.pid is the starting pid, chunk.pid + chunk.length - 1 is the ending pid
            pid_end = chunk.pid + chunk.length - 1
            pid_map[chunk.pid] = (pid_end, chunk.text)
            total_pids += chunk.length

    return PidIndex(pid_map=pid_map, total_pids=total_pids)

