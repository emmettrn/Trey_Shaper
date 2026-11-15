"""
UI schema: the browser builds its controls from this, so adding a parameter to
BoardParams + one entry here is all it takes to expose it in the interface.

STATION_TABLE is the measurement grid (stations x width / rocker / thickness). Its cells
edit the same parameters as the sliders in GROUPS: type exact numbers in the table, or
drag a slider to explore.
"""
from .geometry import NOSE_TYPES, TAIL_TYPES

NOTCHLESS_CLOSING = [k for k, v in TAIL_TYPES.items() if v["closes"]]
BLOCK_TAILS = [k for k, v in TAIL_TYPES.items() if not v["closes"]]


def _label(key: str) -> str:
    return key.replace("_", " ").title()


GROUPS = [
    {
        "name": "Dimensions",
        "fields": [
            dict(key="length", label="Length", min=48, max=120, step=0.25, unit="ftin"),
            dict(key="width", label="Width", min=16, max=25, step=0.125, unit="in"),
            dict(key="thickness", label="Thickness", min=1.75, max=4.0, step=0.0625, unit="in"),
            dict(key="lock_volume", label="Lock volume (scale thickness)", type="bool"),
            dict(key="target_volume", label="Target volume", min=15, max=110, step=0.1, unit="L",
                 show_if=dict(lock_volume=True)),
        ],
    },
    {
        "name": "Outline",
        "fields": [
            dict(key="nose_type", label="Nose", type="select",
                 options=[dict(value=k, label=_label(k)) for k in NOSE_TYPES]),
            dict(key="nose_width_12", label="Nose width @ 12\"", min=6, max=22, step=0.125, unit="in"),
            dict(key="wide_point_offset", label="Wide point from center", min=-10, max=10, step=0.25, unit="in",
                 help="+ toward the nose"),
            dict(key="tail_type", label="Tail", type="select",
                 options=[dict(value=k, label=_label(k)) for k in TAIL_TYPES]),
            dict(key="tail_width_12", label="Tail width @ 12\"", min=8, max=22, step=0.125, unit="in"),
            dict(key="tail_block_width", label="Tail block width", min=5, max=18, step=0.125, unit="in",
                 show_if=dict(tail_type=BLOCK_TAILS)),
            dict(key="swallow_depth", label="Swallow depth", min=1, max=10, step=0.125, unit="in",
                 show_if=dict(tail_type=["swallow"])),
            dict(key="swallow_width", label="Swallow width", min=1, max=12, step=0.125, unit="in",
                 show_if=dict(tail_type=["swallow"])),
        ],
    },
    {
        "name": "Rocker",
        "fields": [
            dict(key="nose_rocker", label="Nose rocker", min=0, max=10, step=0.0625, unit="in",
                 help="dragging keeps the curve shape; the 12\" value follows"),
            dict(key="nose_rocker_12", label="Rocker 12\" from nose", min=0, max=5, step=0.0625, unit="in",
                 help="lower = flatter entry with a later, sharper flip"),
            dict(key="tail_rocker_12", label="Rocker 12\" from tail", min=0, max=3, step=0.0625, unit="in"),
            dict(key="tail_rocker", label="Tail rocker", min=0, max=6, step=0.0625, unit="in"),
            dict(key="rocker_low_point", label="Low point from center", min=-20, max=12, step=0.25, unit="in",
                 help="+ toward the nose"),
        ],
    },
    {
        "name": "Foil",
        "fields": [
            dict(key="nose_thickness", label="Nose tip thickness", min=0.3, max=2.0, step=0.0625, unit="in"),
            dict(key="nose_thickness_12", label="Thickness 12\" from nose", min=0.5, max=3.5, step=0.0625, unit="in",
                 help="higher carries foam toward the nose"),
            dict(key="tail_thickness_12", label="Thickness 12\" from tail", min=0.5, max=3.5, step=0.0625, unit="in"),
            dict(key="tail_thickness", label="Tail thickness", min=0.3, max=2.5, step=0.0625, unit="in"),
            dict(key="thickness_point_offset", label="Thick point from center", min=-12, max=12, step=0.25, unit="in"),
        ],
    },
    {
        "name": "Rails",
        "fields": [
            dict(key="rail_apex", label="Rail apex height", min=0.15, max=0.6, step=0.01, unit="frac",
                 help="0.5 = 50/50 rail, lower = down rail"),
            dict(key="rail_fullness", label="Rail fullness", min=0, max=1, step=0.01, unit="frac"),
            dict(key="deck_dome", label="Deck dome", min=0, max=1, step=0.01, unit="frac"),
            dict(key="rail_hardness_nose", label="Rail edge (nose)", min=0, max=1, step=0.01, unit="frac",
                 help="0 = soft, 1 = hard edge"),
            dict(key="rail_hardness_tail", label="Rail edge (tail)", min=0, max=1, step=0.01, unit="frac"),
        ],
    },
    {
        "name": "Bottom",
        "fields": [
            dict(key="concave_depth", label="Single concave", min=0, max=0.4, step=0.01, unit="in"),
            dict(key="vee_depth", label="Tail vee", min=0, max=0.4, step=0.01, unit="in"),
        ],
    },
]


# A cell is a parameter key, or {"text": ...} for a fixed value, or {"mirror": key} to show
# another parameter's value (the tip widths are set by the nose and tail type).
STATION_TABLE = dict(
    columns=["Width", "Rocker", "Thick"],
    rows=[
        dict(label="Nose tip", cells=[dict(mirror="nose_type"), "nose_rocker", "nose_thickness"]),
        dict(label='12" from nose', cells=["nose_width_12", "nose_rocker_12", "nose_thickness_12"]),
        dict(label="Wide point", cells=["width", dict(text="0"), "thickness"]),
        dict(label='12" from tail', cells=["tail_width_12", "tail_rocker_12", "tail_thickness_12"]),
        dict(label="Tail end", cells=[dict(key="tail_block_width", mirror="tail_type"), "tail_rocker", "tail_thickness"]),
    ],
)
