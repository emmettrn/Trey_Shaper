"""
The browser app (docs/geometry.js) must build the same board as surfboard/geometry.py.

    python tests/test_js_parity.py       (needs Node 18+)
"""
import json, os, random, shutil, subprocess, sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from surfboard import build_board, check_watertight, PRESETS, NOSE_TYPES, TAIL_TYPES

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def random_designs(n, seed=7):
    rng = random.Random(seed)
    out = []
    for _ in range(n):
        L = rng.uniform(56, 120)
        d = dict(
            length=L, width=rng.uniform(17, 24), thickness=rng.uniform(2.0, 3.4),
            wide_point_offset=rng.uniform(-6, 6), nose_type=rng.choice(list(NOSE_TYPES)),
            tail_type=rng.choice(list(TAIL_TYPES)), nose_width_12=rng.uniform(8, 19),
            tail_width_12=rng.uniform(10, 19), tail_block_width=rng.uniform(6, 14),
            swallow_depth=rng.uniform(2, 8), swallow_width=rng.uniform(2, 9),
            nose_rocker=rng.uniform(2, 7), nose_rocker_12=rng.uniform(0.3, 3.5),
            tail_rocker=rng.uniform(0.8, 3.5), tail_rocker_12=rng.uniform(0.1, 1.8),
            rocker_low_point=rng.uniform(-10, 6), nose_thickness=rng.uniform(0.5, 1.4),
            nose_thickness_12=rng.uniform(1.2, 2.6), tail_thickness_12=rng.uniform(1.3, 2.6),
            tail_thickness=rng.uniform(0.6, 1.6), thickness_point_offset=rng.uniform(-6, 6),
            rail_apex=rng.uniform(0.2, 0.55), rail_fullness=rng.random(), deck_dome=rng.random(),
            rail_hardness_nose=rng.random(), rail_hardness_tail=rng.random(),
            concave_depth=rng.uniform(0, 0.3), vee_depth=rng.uniform(0, 0.3),
            lock_volume=rng.random() < 0.25, target_volume=rng.uniform(25, 70),
        )
        if rng.random() < 0.2:      # fraction strings and a v1-style design
            d["width"], d["length"] = "19 3/4", "6'2\""
        if rng.random() < 0.15:
            for k in ("nose_rocker_12", "tail_rocker_12", "nose_thickness_12", "tail_thickness_12"):
                d.pop(k)
            d.update(nose_kick=rng.uniform(1.5, 3.5), tail_kick=rng.uniform(1.5, 3), foil_fullness=rng.uniform(1.5, 3.5))
        out.append(d)
    return out


def test_js_matches_python():
    node = shutil.which("node")
    if not node:
        print("skipped: node not installed")
        return
    designs = list(PRESETS.values()) + [{}] + random_designs(60)
    res = subprocess.run([node, os.path.join(HERE, "js_runner.mjs")], input=json.dumps(designs),
                         capture_output=True, text=True, check=True, cwd=ROOT)
    js = json.loads(res.stdout)
    worst = 0.0
    for d, j in zip(designs, js):
        b = build_board(d)
        s = b.stats()
        tag = json.dumps(d)[:120]
        assert j["watertight"] and check_watertight(b.faces)[0], tag
        assert j["warnings"] == b.warnings, (tag, j["warnings"], b.warnings)
        assert (j["vertices"], j["triangles"]) == (s["vertices"], s["triangles"]), tag
        rel = abs(j["volume_l"] - b.volume_l) / b.volume_l
        worst = max(worst, rel)
        assert rel < 1e-6, (tag, j["volume_l"], b.volume_l)
        assert abs(j["surface_area_in2"] - s["surface_area_in2"]) / s["surface_area_in2"] < 1e-6, tag
        assert abs(j["plan_area_in2"] - s["plan_area_in2"]) < 1e-6, tag
        for a, c in zip(j["stations"], s["stations"]):
            for k in ("width_in", "rocker_in", "thickness_in", "from_nose_in"):
                assert abs(a[k] - c[k]) < 1e-6, (tag, a["label"], k, a[k], c[k])
        assert j["spec"] == b.spec_sheet(), tag
    print(f"{len(designs)} designs match (worst volume difference {worst:.1e}); "
          f"JS build time median {sorted(x['ms'] for x in js)[len(js)//2]:.0f} ms")


def test_data_js_is_current():
    sys.path.insert(0, os.path.join(ROOT, "tools"))
    from build_data import render, OUT
    assert OUT.read_text(encoding="utf-8") == render(), "docs/data.js is stale: run python tools/build_data.py"


if __name__ == "__main__":
    test_data_js_is_current()
    test_js_matches_python()
