"""Match clipping book titles to KFX/MOBI/AZW3 files in a directory."""

import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import yaml


# Bidirectional mapping between sidecar reader extensions and book file extensions
# Key = sidecar extension found in .sdr folder, Value = book file extension
SIDECAR_TO_BOOK_EXT: dict[str, str] = {
    ".azw3r": ".azw3",
    ".yjr": ".kfx",
    ".mbp1": ".mobi",
}

# Reverse mapping: book extension -> sidecar extension
BOOK_EXT_TO_SIDECAR: dict[str, str] = {v: k for k, v in SIDECAR_TO_BOOK_EXT.items()}


@dataclass
class BookInfo:
    """Metadata extracted from a book and its sidecar."""
    book_path: str
    book_title: str
    asin: Optional[str] = None
    author: Optional[str] = None
    language: Optional[str] = None
    book_extension: str = field(default="")


def _normalize_title(title: str) -> str:
    """Normalize a book title for comparison."""
    # Strip BOM
    title = title.lstrip('\ufeff')
    # Lowercase
    title = title.lower()
    # Remove parentheses content
    title = re.sub(r'[（\(].*?[）\)]', '', title)
    # Remove special characters, keep alphanumerics and common CJK chars
    title = re.sub(r'[^\w\s\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]', '', title)
    # Collapse whitespace
    title = re.sub(r'\s+', ' ', title).strip()
    return title


def _extract_volume_number(title: str) -> Optional[int]:
    """Try to extract a volume/series number from a title."""
    # Look for patterns like " 17", "(17)", "vol 17", etc.
    match = re.search(r'(?:^|\s|vol\.?|\(|＃|#)\s*(\d{1,3})\s*(?:$|\s|,|\)|vol)', title, re.IGNORECASE)
    if match:
        return int(match.group(1))
    return None


def _cjk_to_romaji_approx(title: str) -> str:
    """Convert CJK title to a rough romaji approximation for matching."""
    cjk_to_romaji = {
        '無職転生': 'mushokutensei',
        '異世界': 'isekai',
        '行ったら': 'ittara',
        '本気だした': 'honki dashita',
        '理不尽な孫の手': 'rijinrunasonte',
        '超': 'cho',
        '電': 'den',
        '脳': 'nou',
    }
    result = title
    for cjk, romaji in cjk_to_romaji.items():
        result = result.replace(cjk, romaji)
    return result


def get_book_ext_for_reader(reader_ext: str) -> Optional[str]:
    """Get the book file extension for a given sidecar reader extension."""
    return SIDECAR_TO_BOOK_EXT.get(reader_ext)


def get_reader_ext_for_book(book_ext: str) -> Optional[str]:
    """Get the sidecar reader extension for a given book file extension."""
    return BOOK_EXT_TO_SIDECAR.get(book_ext)


def build_book_path_from_sdr(sdr_dir: str, book_ext: str) -> str:
    """Build the expected book file path from an .sdr directory path.

    The book filename is the .sdr folder's basename minus '.sdr', plus the book extension.
    E.g., /some/path/MyBook.abc123.sdr + .kfx -> /some/path/MyBook.abc123.kfx
    """
    sdr_path = Path(sdr_dir)
    sdr_basename = sdr_path.name
    # Strip .sdr from the end
    if sdr_basename.endswith('.sdr'):
        book_basename = sdr_basename[:-4] + book_ext
    else:
        # Fallback: just use the name as-is with the extension
        book_basename = sdr_basename + book_ext
    return str(sdr_path.parent / book_basename)


def _find_matching_book_in_dir(sdr_dir: str, book_ext: str, book_folder: str | None = None) -> Optional[str]:
    """Find a book file for a given .sdr directory in a specific search directory.

    First tries the exact expected path (sdr_name - .sdr + book_ext).
    Falls back to scanning for any file matching the pattern in book_folder if provided.

    Args:
        sdr_dir: Path to the .sdr directory
        book_ext: The book file extension (e.g., '.kfx', '.azw3', '.mobi')
        book_folder: Optional specific directory to search (if None, searches sdr_dir's parent)
    """
    # Method 1: Try the exact expected path first
    expected_path = build_book_path_from_sdr(sdr_dir, book_ext)
    if os.path.isfile(expected_path):
        return expected_path

    # Method 2: If book_folder is provided, scan it for a matching file
    if book_folder:
        folder_path = Path(book_folder)
        sdr_basename = Path(sdr_dir).name
        if sdr_basename.endswith('.sdr'):
            prefix = sdr_basename[:-4]
            for f in folder_path.iterdir():
                if f.is_file() and f.name.startswith(prefix + '.') and f.suffix == book_ext:
                    return str(f)

    return None


def _find_sdr_dirs_for_title(search_dirs: list[str], title: str, book_ext: str) -> Optional[str]:
    """Search multiple directories for a book file matching the given title.

    Looks for .sdr directories whose basename (minus .sdr) matches the title,
    then tries to find the corresponding book file.
    """
    normalized_title = _normalize_title(title)

    for search_dir in search_dirs:
        folder_path = Path(search_dir)
        if not folder_path.is_dir():
            continue

        # Find all .sdr directories in this folder
        for sdr_dir in folder_path.glob("*.sdr"):
            if not sdr_dir.is_dir():
                continue

            sdr_name = sdr_dir.name
            if sdr_name.endswith('.sdr'):
                book_name_prefix = sdr_name[:-4]
            else:
                book_name_prefix = sdr_name

            # Check if the book name prefix matches the title
            normalized_prefix = _normalize_title(book_name_prefix)

            # Try direct match
            if normalized_title == normalized_prefix:
                book_path = _find_matching_book_in_dir(str(sdr_dir), book_ext, str(folder_path))
                if book_path:
                    return book_path

            # Try partial match (one contains the other)
            if normalized_title in normalized_prefix or normalized_prefix in normalized_title:
                book_path = _find_matching_book_in_dir(str(sdr_dir), book_ext, str(folder_path))
                if book_path:
                    return book_path

            # Try volume number matching
            title_volume = _extract_volume_number(normalized_title)
            prefix_volume = _extract_volume_number(normalized_prefix)
            if title_volume and prefix_volume and title_volume == prefix_volume:
                title_words = set(normalized_title.split())
                prefix_words = set(normalized_prefix.split())
                common_words = title_words & prefix_words
                if common_words:
                    book_path = _find_matching_book_in_dir(str(sdr_dir), book_ext, str(folder_path))
                    if book_path:
                        return book_path

    return None


def find_matching_book(
    title: str,
    reader_ext: str,
    book_folder: str | None = None,
    sidecar_dir: str = '.',
    max_books: int | None = None,
) -> Optional[str]:
    """Find a book file matching the given clipping title and reader extension.

    Search order:
    1. If book_folder is provided, search there first
    2. Search in the same directory as the sidecar input
    3. Search in the parent directory of the sidecar input

    The book file extension is determined by the reader_ext via the SIDECAR_TO_BOOK_EXT mapping.

    Args:
        title: Book title from a clipping entry
        reader_ext: The sidecar reader extension (e.g., '.yjr', '.azw3r', '.mbp1')
        book_folder: Optional specific directory to search first
        sidecar_dir: Path to the sidecar directory or file (used to determine search dirs)
        max_books: Optional limit on number of books to process

    Returns:
        Path to the matching book file, or None if no match found
    """
    book_ext = get_book_ext_for_reader(reader_ext)
    if book_ext is None:
        return None

    # Build the list of directories to search in priority order
    search_dirs = []

    # 1. Explicit book_folder if provided
    if book_folder:
        search_dirs.append(book_folder)

    # 2. The sidecar_dir itself (the input directory, which contains .sdr folders and book files)
    sidecar_path = Path(sidecar_dir).resolve()
    search_dirs.append(str(sidecar_path))

    # 3. Parent of the sidecar_dir
    parent = str(sidecar_path.parent)
    if parent not in search_dirs:
        search_dirs.append(parent)

    # 4. Grandparent
    grandparent = str(sidecar_path.parent.parent)
    if grandparent not in search_dirs:
        search_dirs.append(grandparent)

    # Remove any duplicates while preserving order
    seen = set()
    unique_dirs = []
    for d in search_dirs:
        if d not in seen:
            seen.add(d)
            unique_dirs.append(d)
    search_dirs = unique_dirs

    return _find_sdr_dirs_for_title(search_dirs, title, book_ext)


def extract_book_info(book_path: str) -> BookInfo:
    """Extract metadata from a book file and its sidecar."""
    from .kfxlib import YJ_Book

    book = YJ_Book(book_path)
    book.decode_book(skip_book_checks=True)

    # Get metadata from the book
    title = book.get_metadata_value("title", default="Unknown")
    author = book.get_metadata_value("author", default="Unknown")
    asin = book.get_metadata_value("ASIN", default=None)
    language = book.get_metadata_value("language", default=None)
    book_ext = os.path.splitext(book_path)[1]

    # ASIN is already extracted from book metadata above; sidecar files are binary KRDS
    # and require the same decoder, so we rely on the book's metadata

    # Clean fallback title
    fallback_title = os.path.basename(book_path).rsplit('.', 1)[0]
    for ext in ('.sdr', '.yjr', '.azw3r', '.mbp1'):
        fallback_title = fallback_title.rsplit(ext, 1)[0]
    fallback_title = fallback_title.strip(' -_')

    return BookInfo(
        book_path=book_path,
        book_title=title if title not in (None, "Unknown") else fallback_title,
        asin=asin,
        author=author if author != "Unknown" else None,
        language=language,
        book_extension=book_ext,
    )
