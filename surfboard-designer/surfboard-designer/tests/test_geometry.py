"""Run with:  python -m pytest -q   (or just python tests/test_geometry.py)"""
import itertools, os, sys, time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from surfboard import (build_board, check_watertight, parse_inches, fmt_in, fmt_ftin,
                       PRESETS, NOSE_TYPES, TAIL_TYPES)
from surfboard.geometry import BoardParams, rocker_exponents

ROWS = ("nose_tip", "nose_12", "wide", "tail_12", "tail_end")


def stations(board):
    return dict(zip(ROWS, board.station_table()))


def test_presets_watertight_and_hit_every_station():
    for name, pr in PRESETS.items():
        b = build_board(pr)
        ok, unmatched, dup = check_watertight(b.faces)
        assert ok, f"{name}: unmatched={unmatched} dup={dup}"
        assert not b.warnings, f"{name}: {b.warnings}"
        s = stations(b)
        assert abs(s["wide"]["width_in"] - pr["width"]) < 0.02, name
        for side in ("nose", "tail"):
            row = s[f"{side}_12"]
            assert abs(row["width_in"] - pr[f"{side}_width_12"]) < 0.02, name
            assert abs(row["rocker_in"] - pr[f"{side}_rocker_12"]) < 0.005, name
            assert abs(row["thickness_in"] - pr[f"{side}_thickness_12"]) < 0.005, name
        assert abs(s["nose_tip"]["rocker_in"] - pr["nose_rocker"]) < 1e-6, name
        assert abs(s["tail_end"]["rocker_in"] - pr["tail_rocker"]) < 1e-6, name


def test_every_nose_tail_combo_watertight():
    for nose, tail in itertools.product(NOSE_TYPES, TAIL_TYPES):
        b = build_board(dict(nose_type=nose, tail_type=tail))
        ok, unmatched, dup = check_watertight(b.faces)
        assert ok, f"{nose}/{tail}: unmatched={unmatched} dup={dup}"
        assert b.volume_l > 15


def test_curves_stay_fair_on_awkward_boards():
    """The inputs that made the v3 spline overshoot, wiggle or dip below the table."""
    cases = [
        dict(length=110, width=22.5, nose_width_12=19, tail_width_12=19, tail_block_width=9,
             nose_type="blunt", tail_type="square", thickness=3.0, nose_thickness_12=2.6, tail_thickness_12=2.7),
        dict(nose_rocker=5.25, nose_rocker_12=0.6, tail_rocker=2.375, tail_rocker_12=0.3, rocker_low_point=0),
        dict(length=90, width=19, nose_width_12=10, tail_width_12=10.5, tail_type="pin", nose_rocker=6, nose_rocker_12=2),
        dict(tail_block_width=11, tail_width_12=15.5, nose_width_12=12, width=19),
    ]
    for c in cases:
        b = build_board(c)
        pr, p = b._profiles, b.params
        x, h, zb, t = pr["x"], pr["h"], pr["zb"], pr["t"]
        xw, xl = p.length / 2 + p.wide_point_offset, p.length / 2 + p.rocker_low_point
        assert h.max() <= p.width / 2 + 1e-9                       # never wider than the wide point
        assert t.max() <= p.thickness * b.thickness_scale + 1e-9   # never thicker than the thick point
        assert zb.min() >= 0                                       # never below the table
        assert np.all(np.diff(h[x >= xw]) <= 1e-9)                 # outline only narrows toward the nose...
        assert np.all(np.diff(h[(x <= xw) & (x > 1.5)]) >= -1e-9)  # ...and toward the tail (past the corner radius)
        assert np.all(np.diff(zb[x >= xl]) >= -1e-12) and np.all(np.diff(zb[x <= xl]) <= 1e-12)


def test_unreachable_station_is_limited_with_a_warning():
    b = build_board(dict(nose_rocker=2.0, nose_rocker_12=3.0))     # more rocker at 12" than at the tip
    assert any("rocker 12\" from nose" in w for w in b.warnings)
    assert stations(b)["nose_12"]["rocker_in"] < 2.0


def test_pinched_outline_is_limited_instead_of_kinking_at_the_wide_point():
    b = build_board(dict(width=19, nose_width_12=4.0))
    assert any('width 12" from nose' in w for w in b.warnings)
    h, x = b._profiles["h"], b._profiles["x"]
    xw = b.params.length / 2 + b.params.wide_point_offset
    near = (x > xw) & (x < xw + 3)
    assert np.abs(np.gradient(h, x)[near]).max() < 0.25        # still close to level just past the wide point


def test_v1_designs_keep_their_shape():
    old = dict(length=72, nose_rocker=5.0, tail_rocker=2.2, rocker_low_point=-5, nose_kick=2.4, tail_kick=2.0,
               thickness=2.44, nose_thickness=0.85, tail_thickness=1.2, foil_fullness=2.0)
    b = build_board(old)
    kn, kt = rocker_exponents(b.params)
    assert abs(kn - 2.4) < 1e-9 and abs(kt - 2.0) < 1e-9
    assert not b.warnings


def test_volume_lock():
    b = build_board(dict(lock_volume=True, target_volume=32.0))
    assert abs(b.volume_l - 32.0) < 0.01


def test_fraction_parsing_round_trip():
    for text, value in (("19 3/4", 19.75), ("19-3/4", 19.75), ("1' 7 3/4\"", 19.75), ("6'0\"", 72), ("6 ft 2 in", 74),
                        ("1/2", 0.5), ("-1/2", -0.5), ("−1", -1.0), ("2.44", 2.44), ("6’ 2”", 74)):
        assert abs(parse_inches(text) - value) < 1e-9, text
    assert fmt_in(19.75) == '19 3/4"' and fmt_in(-0.5) == '-1/2"' and fmt_ftin(74.5) == "6'2 1/2\""
    assert build_board(dict(width="19 3/4", length="6'2\"")).stats()["width_in"] == 19.75


if __name__ == "__main__":
    t0 = time.perf_counter()
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in tests:
        fn()
    for name, pr in PRESETS.items():
        s = build_board(pr).stats()
        print(f"{name:30s} {s['volume_l']:6.2f} L  w={s['width_in']:.2f}  t={s['thickness_in']:.2f}  tris={s['triangles']}")
    print(f"{len(tests)} tests passed in {time.perf_counter() - t0:.2f}s")
