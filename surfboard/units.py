"""
Feet / inches / fractions: reading and showing.

Carried over from surfboard_cad_v3.py so measurements can be typed the way shapers
write them:   19    19.75    19 3/4    19-3/4    1/2    6'0"    1' 7 3/4"
"""
from __future__ import annotations

import math
import re

_FRACTION = re.compile(r"^(\d+)/(\d+)$")
_QUOTES = (("”", '"'), ("“", '"'), ("″", '"'),
           ("’", "'"), ("‘", "'"), ("′", "'"), ("−", "-"))


def _num(token: str) -> float:
    m = _FRACTION.match(token)
    if m:
        den = int(m.group(2))
        if den == 0:
            raise ValueError("zero denominator")
        return int(m.group(1)) / den
    return float(token)


def parse_inches(text: str | float | int) -> float:
    """'19 3/4' -> 19.75   |   "1' 7 3/4\\"" -> 19.75   |   '-1/2' -> -0.5   |   2.5 -> 2.5"""
    if isinstance(text, (int, float)):
        return float(text)
    s = text.strip().lower()
    if not s:
        raise ValueError("empty")
    for bad, good in _QUOTES:
        s = s.replace(bad, good)
    sign = 1.0
    if s.startswith("-"):                      # a leading minus is a sign...
        sign, s = -1.0, s[1:]
    s = re.sub(r"\b(feet|foot|ft)\b", "'", s)
    s = re.sub(r"\b(inches|inch|in)\b", '"', s)
    feet = 0.0
    if "'" in s:
        f, s = s.split("'", 1)
        feet = _num(f.strip() or "0")
    s = s.replace('"', " ").replace("-", " ")   # ...a hyphen inside is a separator: 19-3/4
    s = re.sub(r"\s*/\s*", "/", s)
    result = sign * (feet * 12.0 + sum(_num(tok) for tok in s.split()))
    if not math.isfinite(result):
        raise ValueError("not a number")
    return result


def fmt_in(inches: float, denom: int = 16) -> str:
    """19.75 -> 19 3/4\"   (nearest 1/16)"""
    n = int(round(abs(inches) * denom))
    whole, rem = divmod(n, denom)
    if rem:
        g = math.gcd(rem, denom)
        frac = f"{rem // g}/{denom // g}"
        s = f"{whole} {frac}" if whole else frac
    else:
        s = str(whole)
    return ("-" if inches < 0 and n else "") + s + '"'


def fmt_ftin(inches: float, denom: int = 16) -> str:
    """72 -> 6'0\"     75.5 -> 6'3 1/2\""""
    total = int(round(inches * denom))
    feet, rem = divmod(total, 12 * denom)
    return f"{feet}'{fmt_in(rem / denom, denom)}"
