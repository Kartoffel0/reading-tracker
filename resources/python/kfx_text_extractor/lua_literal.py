"""Parse the literal Lua tables KOReader writes into sidecar metadata files.

KOReader stores reader state (annotations, book metadata, view settings) as a
single ``return { ... }`` table literal in ``metadata.<format>.lua``. That
subset is small - strings, numbers, booleans, nil and nested tables - so this
module parses it directly instead of depending on a Lua runtime.
"""

import re


class LuaParseError(ValueError):
    """Raised when a sidecar metadata file is not a parseable Lua table."""


_TOKEN_RE = re.compile(
    r"""
      (?P<space>\s+)
    | (?P<comment>--\[\[.*?\]\]|--[^\n]*)
    | (?P<string>"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')
    | (?P<number>0[xX][0-9A-Fa-f]+|(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?)
    | (?P<name>[A-Za-z_][A-Za-z0-9_]*)
    | (?P<symbol>[{}\[\]=,;\-])
    """,
    re.VERBOSE | re.DOTALL,
)

_ESCAPES = {
    "a": "\a",
    "b": "\b",
    "f": "\f",
    "n": "\n",
    "r": "\r",
    "t": "\t",
    "v": "\v",
    "\\": "\\",
    "'": "'",
    '"': '"',
    "\n": "\n",
}


class _Token:
    __slots__ = ("kind", "value", "position")

    def __init__(self, kind, value, position):
        self.kind = kind
        self.value = value
        self.position = position


def _tokenize(text):
    """Split Lua source into significant tokens, dropping whitespace/comments."""
    tokens = []
    position = 0
    while position < len(text):
        match = _TOKEN_RE.match(text, position)
        if match is None:
            raise LuaParseError(
                "Unexpected character %r at offset %d" % (text[position], position)
            )
        kind = match.lastgroup
        value = match.group()
        if kind not in ("space", "comment"):
            tokens.append(_Token(kind, value, position))
        position = match.end()
    return tokens


def _unescape(raw):
    """Decode a Lua string literal body (without surrounding quotes)."""
    result = []
    index = 0
    while index < len(raw):
        char = raw[index]
        if char != "\\":
            result.append(char)
            index += 1
            continue

        index += 1
        if index >= len(raw):
            break
        escape = raw[index]
        if escape in _ESCAPES:
            result.append(_ESCAPES[escape])
            index += 1
        elif escape == "x":
            result.append(chr(int(raw[index + 1:index + 3], 16)))
            index += 3
        elif escape.isdigit():
            end = index
            while end < len(raw) and end < index + 3 and raw[end].isdigit():
                end += 1
            result.append(chr(int(raw[index:end])))
            index = end
        elif escape == "z":
            index += 1
            while index < len(raw) and raw[index].isspace():
                index += 1
        else:
            result.append(escape)
            index += 1
    return "".join(result)


class _Parser:
    """Recursive-descent parser for the Lua literal subset."""

    def __init__(self, tokens):
        self._tokens = tokens
        self._index = 0

    def peek(self, offset=0):
        index = self._index + offset
        return self._tokens[index] if index < len(self._tokens) else None

    def advance(self):
        token = self.peek()
        if token is None:
            raise LuaParseError("Unexpected end of input")
        self._index += 1
        return token

    def _expect_symbol(self, symbol):
        token = self.advance()
        if token.kind != "symbol" or token.value != symbol:
            raise LuaParseError(
                "Expected %r at offset %d, got %r"
                % (symbol, token.position, token.value)
            )

    def parse_value(self):
        token = self.peek()
        if token is None:
            raise LuaParseError("Unexpected end of input")

        if token.kind == "symbol":
            if token.value == "{":
                return self._parse_table()
            if token.value == "-":
                self.advance()
                return -self._parse_number()
        elif token.kind == "string":
            self.advance()
            return _unescape(token.value[1:-1])
        elif token.kind == "number":
            self.advance()
            return self._convert_number(token.value)
        elif token.kind == "name":
            self.advance()
            if token.value == "true":
                return True
            if token.value == "false":
                return False
            if token.value == "nil":
                return None

        raise LuaParseError(
            "Unexpected token %r at offset %d" % (token.value, token.position)
        )

    def _parse_number(self):
        token = self.advance()
        if token.kind != "number":
            raise LuaParseError(
                "Expected a number at offset %d, got %r" % (token.position, token.value)
            )
        return self._convert_number(token.value)

    @staticmethod
    def _convert_number(raw):
        if raw[:2].lower() == "0x":
            return int(raw, 16)
        if any(char in raw for char in ".eE"):
            return float(raw)
        return int(raw)

    def _parse_table(self):
        self._expect_symbol("{")
        result = {}
        array_index = 1

        while True:
            token = self.peek()
            if token is None:
                raise LuaParseError("Unterminated table")

            if token.kind == "symbol" and token.value == "}":
                self.advance()
                return result

            if token.kind == "symbol" and token.value == "[":
                self.advance()
                key = self.parse_value()
                self._expect_symbol("]")
                self._expect_symbol("=")
                result[key] = self.parse_value()
            elif (
                token.kind == "name"
                and self.peek(1) is not None
                and self.peek(1).kind == "symbol"
                and self.peek(1).value == "="
            ):
                self.advance()
                self.advance()
                result[token.value] = self.parse_value()
            else:
                result[array_index] = self.parse_value()
                array_index += 1

            separator = self.peek()
            if separator is not None and separator.kind == "symbol" and separator.value in (",", ";"):
                self.advance()


def parse_lua_table(text):
    """Parse a Lua table literal (optionally preceded by ``return``).

    Returns the table as a dict; array-style fields use 1-based integer keys.
    """
    parser = _Parser(_tokenize(text))
    first = parser.peek()
    if first is not None and first.kind == "name" and first.value == "return":
        parser.advance()

    value = parser.parse_value()
    if parser.peek() is not None:
        token = parser.peek()
        raise LuaParseError(
            "Unexpected trailing token %r at offset %d" % (token.value, token.position)
        )
    if not isinstance(value, dict):
        raise LuaParseError("Expected a table, got %s" % type(value).__name__)
    return value


def load_lua_table(path):
    """Read and parse a KOReader Lua metadata file (UTF-8, BOM tolerant)."""
    with open(path, "r", encoding="utf-8-sig") as handle:
        return parse_lua_table(handle.read())
