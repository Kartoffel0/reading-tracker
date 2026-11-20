"""Read EPUB text and resolve KOReader (CREngine) XPointer positions.

KOReader sidecars locate annotations with CREngine XPointers such as
``/body/DocFragment[9]/body/p[114]/text().1``. This module flattens an EPUB into
one text stream and maps those XPointers onto character offsets in it, so EPUB
sessions can be extracted the same way as KFX pid ranges.

Offsets follow CREngine semantics: ``text().N`` is a 0-based character offset
inside the N-th direct text node of its element.
"""

import posixpath
import re
import zipfile
from dataclasses import dataclass, field
from urllib.parse import unquote

from lxml import etree


CONTAINER_PATH = "META-INF/container.xml"

# Elements that start a new line in the flattened text.
BLOCK_TAGS = frozenset({
    "address", "article", "aside", "blockquote", "body", "caption", "dd", "div",
    "dl", "dt", "figcaption", "figure", "footer", "h1", "h2", "h3", "h4", "h5",
    "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section",
    "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
})

# Subtrees with no readable content (ruby annotations, styling, scripts, media).
SKIP_TAGS = frozenset({
    "head", "title", "script", "style", "rt", "rp", "svg", "math",
})

LINE_BREAK_TAGS = frozenset({"br"})

_XPOINTER_RE = re.compile(r"^(?P<path>/.*)\.(?P<offset>[0-9]+)$")
_STEP_RE = re.compile(r"^(?P<name>[^\[]+?)(?:\[(?P<index>[1-9][0-9]*)\])?$")


def _normalize_step(step):
    """Rewrite an XPointer step to the spelling the indexer records.

    CREngine numbers every step (`body[1]`, `div[1]`, `text()[1]`), while
    ``_DocumentText`` omits the index for the first sibling of a name. Drop a
    ``[1]`` index and keep the rest unchanged.
    """
    match = _STEP_RE.match(step)
    if match is None:
        return step
    name = match.group("name")
    index = int(match.group("index") or "1")
    return name if index == 1 else "%s[%d]" % (name, index)


@dataclass
class _DocumentMap:
    """Offset tables for one spine document."""
    fragment: int
    base: int
    elements: dict = field(repr=False)
    texts: dict = field(repr=False)
    text_lengths: dict = field(repr=False)


@dataclass
class EpubIndex:
    """A character-offset text index for an EPUB book.

    pid_map: dict mapping chunk start offset -> (chunk end offset, text)
    total_pids: total number of characters in the flattened book text
    """
    pid_map: dict
    total_pids: int
    documents: list = field(default_factory=list, repr=False)

    def resolve_position(self, pos):
        """Resolve a KOReader XPointer (or numeric offset) to a text offset."""
        if isinstance(pos, int):
            return pos
        if not isinstance(pos, str):
            return None

        value = pos.strip()
        if value.startswith("/"):
            return self._resolve_xpointer(value)
        if value.startswith("epubcfi("):
            return None
        try:
            return int(value.rsplit(":", 1)[-1])
        except ValueError:
            return None

    def _resolve_xpointer(self, xpointer):
        match = _XPOINTER_RE.match(xpointer)
        if match is None:
            return None
        offset = int(match.group("offset"))

        steps = [
            _normalize_step(step)
            for step in match.group("path").split("/")
            if step
        ]
        if len(steps) < 3 or steps[0] != "body":
            return None

        fragment_match = _STEP_RE.match(steps[1])
        if fragment_match is None or fragment_match.group("name") != "DocFragment":
            return None
        fragment = int(fragment_match.group("index") or "1")

        # CREngine always emits the document's own body step after DocFragment.
        if steps[2] != "body":
            return None
        rest = steps[3:]

        text_index = None
        if rest:
            last_match = _STEP_RE.match(rest[-1])
            if last_match is not None and last_match.group("name") == "text()":
                text_index = int(last_match.group("index") or "1")
                rest = rest[:-1]

        document = next(
            (entry for entry in self.documents if entry.fragment == fragment),
            None,
        )
        if document is None:
            return None

        # Use the same DocFragment spelling the indexer records (index omitted for
        # the first spine document).
        path = ("body", _fragment_step(fragment), "body") + tuple(rest)
        if text_index is not None:
            local_offset = document.texts.get((path, text_index))
            if local_offset is None:
                return None
            node_length = document.text_lengths.get((path, text_index), 0)
            offset = min(offset, node_length)
        else:
            local_offset = document.elements.get(path)
            if local_offset is None:
                return None

        return document.base + local_offset + offset


def _local_name(tag):
    return tag.rpartition("}")[2] if isinstance(tag, str) else ""


def _xml_parser():
    return etree.XMLParser(resolve_entities=False, no_network=True, recover=True)


def _fragment_step(fragment_index):
    return "DocFragment" if fragment_index == 1 else "DocFragment[%d]" % fragment_index


class _DocumentText:
    """Flatten one spine document, recording element and text-node offsets."""

    def __init__(self):
        self.parts = []
        self.length = 0
        self.elements = {}
        self.texts = {}
        self.text_lengths = {}
        self._last_char = ""

    def _emit(self, text):
        if not text:
            return
        self.parts.append(text)
        self.length += len(text)
        self._last_char = text[-1]

    def _ensure_newline(self):
        if self.length and self._last_char != "\n":
            self._emit("\n")

    def text(self):
        return "".join(self.parts)

    def walk_body(self, body, fragment_index):
        path = ("body", _fragment_step(fragment_index), "body")
        self._walk(body, path)

    def _walk(self, element, path):
        name = _local_name(element.tag)
        if name in SKIP_TAGS:
            return

        block = name in BLOCK_TAGS
        if block:
            self._ensure_newline()

        self.elements[path] = self.length

        node_index = 0
        if element.text:
            node_index += 1
            self.texts[(path, node_index)] = self.length
            self.text_lengths[(path, node_index)] = len(element.text)
            self._emit(element.text)

        child_counts = {}
        for child in element:
            child_name = _local_name(child.tag)
            child_counts[child_name] = child_counts.get(child_name, 0) + 1

            if child_name in LINE_BREAK_TAGS:
                self._ensure_newline()
            elif child_name not in SKIP_TAGS:
                step = (
                    child_name
                    if child_counts[child_name] == 1
                    else "%s[%d]" % (child_name, child_counts[child_name])
                )
                self._walk(child, path + (step,))

            if child.tail:
                node_index += 1
                self.texts[(path, node_index)] = self.length
                self.text_lengths[(path, node_index)] = len(child.tail)
                self._emit(child.tail)

        if block:
            self._ensure_newline()


def _add_line_chunks(pid_map, text, base):
    """Chunk the flattened text on newlines, keeping trailing newlines."""
    start = 0
    for index, char in enumerate(text):
        if char != "\n":
            continue
        pid_map[base + start] = (base + index, text[start:index + 1])
        start = index + 1
    if start < len(text):
        pid_map[base + start] = (base + len(text) - 1, text[start:])


def _read_opf_path(archive):
    container = etree.fromstring(archive.read(CONTAINER_PATH), parser=_xml_parser())
    for element in container.iter():
        if _local_name(element.tag) == "rootfile" and element.get("full-path"):
            return element.get("full-path")
    raise ValueError("EPUB container has no rootfile")


def _read_spine(archive):
    """Return spine document paths in reading order."""
    opf_path = _read_opf_path(archive)
    opf = etree.fromstring(archive.read(opf_path), parser=_xml_parser())

    manifest = {}
    for element in opf.iter():
        if _local_name(element.tag) == "item" and element.get("id") and element.get("href"):
            manifest[element.get("id")] = unquote(element.get("href"))

    opf_dir = posixpath.dirname(opf_path)
    spine = []
    for element in opf.iter():
        if _local_name(element.tag) != "itemref":
            continue
        href = manifest.get(element.get("idref"))
        if href:
            spine.append(posixpath.normpath(posixpath.join(opf_dir, href)))

    if not spine:
        raise ValueError("EPUB spine is empty")
    return spine


def _spine_documents(archive):
    """Yield (fragment_index, document_root) for each parseable spine document."""
    for fragment_index, href in enumerate(_read_spine(archive), 1):
        try:
            root = etree.fromstring(archive.read(href), parser=_xml_parser())
        except Exception:
            continue
        bodies = [element for element in root.iter() if _local_name(element.tag) == "body"]
        if bodies:
            yield fragment_index, bodies[0]


def build_epub_index(epub_path):
    """Build a character-offset index (and XPointer map) from an EPUB file."""
    pid_map = {}
    documents = []
    base = 0

    with zipfile.ZipFile(epub_path) as archive:
        for fragment_index, body in _spine_documents(archive):
            builder = _DocumentText()
            builder.walk_body(body, fragment_index)
            text = builder.text()

            documents.append(_DocumentMap(
                fragment=fragment_index,
                base=base,
                elements=builder.elements,
                texts=builder.texts,
                text_lengths=builder.text_lengths,
            ))
            _add_line_chunks(pid_map, text, base)
            base += len(text)

    return EpubIndex(pid_map=pid_map, total_pids=base, documents=documents)


def read_epub_metadata(epub_path):
    """Read Dublin Core metadata (title/author/language/identifier) from an EPUB."""
    with zipfile.ZipFile(epub_path) as archive:
        opf_path = _read_opf_path(archive)
        opf = etree.fromstring(archive.read(opf_path), parser=_xml_parser())

    namespace = "{http://purl.org/dc/elements/1.1/}"

    def _first(field):
        for element in opf.iter(namespace + field):
            if element.text and element.text.strip():
                return element.text.strip()
        for element in opf.iter():
            if _local_name(element.tag) == field and element.text and element.text.strip():
                return element.text.strip()
        return None

    return {
        "title": _first("title"),
        "author": _first("creator"),
        "language": _first("language"),
        "identifier": _first("identifier"),
    }
