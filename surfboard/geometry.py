"""
Parametric surfboard geometry.

Coordinate system (board space, inches):
    x : along the stringer, 0 = tail end, L = nose tip
    y : across the board, 0 = stringer, + = right rail (looking down at the deck, nose up)
    z : vertical, 0 = lowest point of the bottom rocker, + = toward the deck

The board is specified the way a shaper measures one: width, rocker and thickness at
five stations (nose tip, 12" from the nose, the wide/low/thick point, 12" from the tail,
tail end). Each curve has one free shape exponent per side, and it is solved in closed
form so the curve passes through the 12" measurement exactly.

The board is built as a loft:
    1. Outline (planform)  -> half-width h(x)
    2. Rocker              -> bottom centerline z_b(x)
    3. Foil                -> thickness t(x)
    4. Rail/section shape  -> closed cross-section at every station, built from two
                              superellipses (deck + bottom) that meet at the rail apex
    5. Stations are stitched into a watertight triangle mesh, ends are capped,
       swallow notches get side walls.

Volume is computed exactly from the mesh (divergence theorem). With lock_volume the
thickness profile is scaled until the mesh hits the target volume.
"""
from __future__ import annotations

from dataclasses import dataclass, asdict, field
import math
import numpy as np

from .units import parse_inches, fmt_in, fmt_ftin

IN3_TO_L = 0.016387064  # cubic inches -> liters

# Allowed range for the solved shape exponents. Outside it the curve stops looking like a
# board (a crease at the low point, or a dead-flat board with a hook at the very end), so
# the 12" measurement is limited to what a fair curve can reach.
A_MIN = 1.2                  # outline: h = W/2 * (1 - u^a)^(1/b); below this the wide point becomes a corner
K_MIN, K_MAX = 1.3, 6.0      # rocker:  z = R * u^k
P_MIN, P_MAX = 1.2, 8.0      # foil:    t = t_end + (T - t_end) * (1 - u^p)

# Nose closure exponent b: 1 = pointed tip, 2 = elliptical (round), 3 = blunt / squared off
NOSE_TYPES: dict[str, float] = {
    "pointed": 1.0,
    "semi_pointed": 1.4,
    "round": 2.0,
    "blunt": 3.0,
}

# closes: outline goes to zero width at the tail; b: closure exponent;
# corner: corner radius (in) where the outline meets the tail block; notch: swallow
TAIL_TYPES: dict[str, dict] = {
    "squash":      dict(closes=False, b=1.0, corner=1.25, notch=False),
    "square":      dict(closes=False, b=1.0, corner=0.15, notch=False),
    "swallow":     dict(closes=False, b=1.0, corner=0.40, notch=True),
    "round":       dict(closes=True,  b=2.0, corner=0.0,  notch=False),
    "rounded_pin": dict(closes=True,  b=1.5, corner=0.0,  notch=False),
    "pin":         dict(closes=True,  b=1.15, corner=0.0, notch=False),
}


@dataclass
class BoardParams:
    # --- Dimensions (inches) ---
    length: float = 72.0              # 6'0"
    width: float = 19.5               # max width
    thickness: float = 2.44           # max thickness
    wide_point_offset: float = -1.0   # wide point relative to center, + toward nose

    # --- Outline ---
    nose_type: str = "pointed"
    tail_type: str = "squash"
    nose_width_12: float = 12.0       # width 12" from the nose tip
    tail_width_12: float = 14.5       # width 12" from the tail end
    tail_block_width: float = 10.0    # width at the tail end (squash/square/swallow)
    swallow_depth: float = 4.5        # notch depth along the stringer
    swallow_width: float = 5.0        # notch width at the tail end

    # --- Rocker: bottom height above a flat table that touches the low point (inches) ---
    nose_rocker: float = 5.0          # at the nose tip
    nose_rocker_12: float = 2.1875    # 12" back from the nose tip
    tail_rocker_12: float = 0.8125    # 12" up from the tail end
    tail_rocker: float = 2.2          # at the tail end
    rocker_low_point: float = -5.0    # lowest point relative to center, + toward nose

    # --- Foil (inches) ---
    nose_thickness: float = 0.85      # at the nose tip (before the tip pinches closed)
    nose_thickness_12: float = 1.75   # 12" back from the nose tip
    tail_thickness_12: float = 1.875  # 12" up from the tail end
    tail_thickness: float = 1.20      # at the tail end
    thickness_point_offset: float = 0.0  # thickest point relative to center, + toward nose

    # --- Rails ---
    rail_apex: float = 0.35           # rail apex height as a fraction of thickness (0.5 = 50/50 rail)
    rail_fullness: float = 0.5        # 0 = thin/domed, 1 = full/boxy
    deck_dome: float = 0.35           # 0 = flat deck, 1 = strongly domed (thinner rails)
    rail_hardness_nose: float = 0.25  # 0 = soft (egg) rail, 1 = hard edge
    rail_hardness_tail: float = 0.85

    # --- Bottom contours (inches) ---
    concave_depth: float = 0.12       # single concave, center raised
    vee_depth: float = 0.0            # vee in the tail, center lowered

    # --- Volume ---
    lock_volume: bool = False
    target_volume: float = 29.0       # liters

    # --- Resolution ---
    stations: int = 161
    section_points: int = 48          # points per half cross-section

    def validated(self) -> tuple["BoardParams", list[str]]:
        """Return a copy clamped into a buildable range, plus human-readable warnings."""
        p = BoardParams(**asdict(self))
        w: list[str] = []

        def clamp(name, lo, hi, label=None):
            v = getattr(p, name)
            nv = min(max(v, lo), hi)
            if abs(nv - v) > 1e-9:
                w.append(f"{label} limited to {fmt_in(nv)}" if label else f"{name} clamped to {nv:.2f}")
                setattr(p, name, nv)

        if p.nose_type not in NOSE_TYPES:
            w.append(f"unknown nose_type '{p.nose_type}', using pointed")
            p.nose_type = "pointed"
        if p.tail_type not in TAIL_TYPES:
            w.append(f"unknown tail_type '{p.tail_type}', using squash")
            p.tail_type = "squash"

        clamp("length", 40.0, 144.0)
        clamp("width", 14.0, 26.0)
        clamp("thickness", 1.5, 4.5)
        half = p.length / 2
        clamp("wide_point_offset", -(half - 14), half - 14)
        clamp("rocker_low_point", -(half - 14), half - 14)
        clamp("thickness_point_offset", -(half - 14), half - 14)

        clamp("nose_width_12", 3.0, p.width - 0.5)
        tail = TAIL_TYPES[p.tail_type]
        if tail["closes"]:
            clamp("tail_width_12", 4.0, p.width - 0.5)
        else:
            clamp("tail_block_width", 4.0, p.width - 2.0)
            clamp("tail_width_12", p.tail_block_width + 0.5, p.width - 0.5)
        if tail["notch"]:
            clamp("swallow_width", 1.0, p.tail_block_width - 2 * tail["corner"] - 1.0)
            clamp("swallow_depth", 1.0, 10.0)

        # 12" widths: keep the outline leaving the wide point smoothly
        xw = half + p.wide_point_offset
        rn = (1 - _u12(p.length, xw, True) ** A_MIN) ** (1 / NOSE_TYPES[p.nose_type])
        clamp("nose_width_12", p.width * rn, p.width - 0.5, 'width 12" from nose')
        te = 0.0 if tail["closes"] else p.tail_block_width / p.width
        rt = (1 - _u12(p.length, xw, False) ** A_MIN) ** (1 / tail["b"])
        clamp("tail_width_12", p.width * (te + (1 - te) * rt), p.width - 0.5, 'width 12" from tail')

        clamp("nose_rocker", 0.0, 12.0)
        clamp("tail_rocker", 0.0, 8.0)
        clamp("nose_thickness", 0.3, p.thickness)
        clamp("tail_thickness", 0.3, p.thickness)

        # 12" stations: keep each measurement where a fair curve can reach it
        xl, xt = half + p.rocker_low_point, half + p.thickness_point_offset
        for side, nose in (("nose", True), ("tail", False)):
            R, u = getattr(p, f"{side}_rocker"), _u12(p.length, xl, nose)
            clamp(f"{side}_rocker_12", R * u ** K_MAX, R * u ** K_MIN, f'rocker 12" from {side}')
            te, u = getattr(p, f"{side}_thickness"), _u12(p.length, xt, nose)
            span = p.thickness - te
            clamp(f"{side}_thickness_12", te + span * (1 - u ** P_MIN), te + span * (1 - u ** P_MAX),
                  f'thickness 12" from {side}')
        clamp("rail_apex", 0.15, 0.6)
        for n in ("rail_fullness", "deck_dome", "rail_hardness_nose", "rail_hardness_tail"):
            clamp(n, 0.0, 1.0)
        clamp("concave_depth", 0.0, 0.4)
        clamp("vee_depth", 0.0, 0.4)
        clamp("target_volume", 10.0, 120.0)
        p.stations = int(min(max(p.stations, 41), 401))
        p.section_points = int(min(max(p.section_points, 16), 128))
        return p, w


# ---------------------------------------------------------------------------
# 1D profiles
# ---------------------------------------------------------------------------

def _smoothstep(t):
    t = np.clip(t, 0.0, 1.0)
    return t * t * (3 - 2 * t)


def _closure_exponent(r: float, b: float, u_ref: float) -> float:
    """Solve (1 - u_ref^a)^(1/b) = r for a. Used to hit the 12" width exactly."""
    r = min(max(r, 1e-3), 0.999)
    return math.log(1 - r ** b) / math.log(u_ref)


def half_width(p: BoardParams, x: np.ndarray) -> np.ndarray:
    """Outline half-width h(x). Hits max width at the wide point and the 12" widths exactly."""
    L, W2 = p.length, p.width / 2
    xw = L / 2 + p.wide_point_offset
    h = np.zeros_like(x, dtype=float)

    # Nose side: g = (1 - u^a)^(1/b)
    m = x >= xw
    bn = NOSE_TYPES[p.nose_type]
    an = _closure_exponent(p.nose_width_12 / p.width, bn, (L - 12 - xw) / (L - xw))
    u = (x[m] - xw) / (L - xw)
    h[m] = W2 * np.clip(1 - u ** an, 0, 1) ** (1 / bn)

    # Tail side: g = te + (1 - te) (1 - v^a)^(1/b)
    tail = TAIL_TYPES[p.tail_type]
    bt = tail["b"]
    te = 0.0 if tail["closes"] else p.tail_block_width / p.width
    r = (p.tail_width_12 / p.width - te) / (1 - te)
    at = _closure_exponent(r, bt, (xw - 12) / xw)
    v = (xw - x[~m]) / xw
    h[~m] = W2 * (te + (1 - te) * np.clip(1 - v ** at, 0, 1) ** (1 / bt))

    # Round off the tail corners (square/squash/swallow)
    rc = tail["corner"]
    if rc > 0:
        c = x < rc
        h[c] = h[c] - rc + np.sqrt(np.maximum(rc ** 2 - (rc - x[c]) ** 2, 0))
    return np.maximum(h, 0.0)


def notch_half_width(p: BoardParams, x: np.ndarray) -> np.ndarray:
    """Inner half-width of a swallow notch (V shape). Zero for other tails."""
    if not TAIL_TYPES[p.tail_type]["notch"]:
        return np.zeros_like(x, dtype=float)
    return np.clip(p.swallow_width / 2 * (1 - x / p.swallow_depth), 0, None)


def _u12(L: float, x0: float, nose: bool) -> float:
    """Where the 12" station sits between a curve's origin x0 (u = 0) and the end (u = 1)."""
    return (L - 12.0 - x0) / (L - x0) if nose else (x0 - 12.0) / x0


def rocker_exponents(p: BoardParams) -> tuple[float, float]:
    """(nose, tail) exponents k so that R * u12^k equals the rocker measured at 12"."""
    xl = p.length / 2 + p.rocker_low_point
    out = []
    for R, r12, nose in ((p.nose_rocker, p.nose_rocker_12, True), (p.tail_rocker, p.tail_rocker_12, False)):
        k = 2.0
        if R > 1e-9:
            k = K_MAX if r12 <= 0 else math.log(r12 / R) / math.log(_u12(p.length, xl, nose))
        out.append(min(max(k, K_MIN), K_MAX))
    return out[0], out[1]


def foil_exponents(p: BoardParams) -> tuple[float, float]:
    """(nose, tail) exponents so the foil passes through the thickness measured at 12"."""
    xt = p.length / 2 + p.thickness_point_offset
    out = []
    for te, t12, nose in ((p.nose_thickness, p.nose_thickness_12, True), (p.tail_thickness, p.tail_thickness_12, False)):
        e = 2.0
        if p.thickness - te > 1e-9:
            drop = 1 - (t12 - te) / (p.thickness - te)        # = u12^e
            e = P_MAX if drop <= 0 else P_MIN if drop >= 1 else math.log(drop) / math.log(_u12(p.length, xt, nose))
        out.append(min(max(e, P_MIN), P_MAX))
    return out[0], out[1]


def rocker(p: BoardParams, x: np.ndarray) -> np.ndarray:
    """Bottom centerline height z_b(x): zero and level at the low point, a power curve to each end."""
    L = p.length
    xl = L / 2 + p.rocker_low_point
    kn, kt = rocker_exponents(p)
    nose = p.nose_rocker * np.clip((x - xl) / (L - xl), 0, 1) ** kn
    tail = p.tail_rocker * np.clip((xl - x) / xl, 0, 1) ** kt
    return np.where(x >= xl, nose, tail)


def thickness(p: BoardParams, x: np.ndarray, h: np.ndarray, scale: float = 1.0) -> np.ndarray:
    """Foil t(x), pinched toward zero where the outline gets narrow (keeps tips sane)."""
    L = p.length
    xt = L / 2 + p.thickness_point_offset
    nose_side = x >= xt
    u = np.where(nose_side, (x - xt) / (L - xt), (xt - x) / xt)
    t_end = np.where(nose_side, p.nose_thickness, p.tail_thickness)
    en, et = foil_exponents(p)
    t = t_end + (p.thickness - t_end) * (1 - np.clip(u, 0, 1) ** np.where(nose_side, en, et))
    t = t * scale
    return t * np.tanh(1.5 * h / np.maximum(t, 1e-9))


def rail_hardness(p: BoardParams, x: np.ndarray) -> np.ndarray:
    s = _smoothstep((x - 0.15 * p.length) / (0.6 * p.length))  # 0 at tail, 1 toward nose
    return p.rail_hardness_tail + (p.rail_hardness_nose - p.rail_hardness_tail) * s


def concave_profile(p: BoardParams, x: np.ndarray) -> np.ndarray:
    L = p.length
    entry = _smoothstep((0.80 * L - x) / (0.25 * L))   # fades in behind the nose
    exit_ = _smoothstep(x / 3.0)                        # runs out at the tail
    return p.concave_depth * entry * exit_


def vee_profile(p: BoardParams, x: np.ndarray) -> np.ndarray:
    L = p.length
    return p.vee_depth * _smoothstep((0.35 * L - x) / (0.30 * L))


# ---------------------------------------------------------------------------
# Cross sections
# ---------------------------------------------------------------------------

def _sections(p: BoardParams, x, h, yin, t, zb, n_out: int):
    """
    Build the right-half cross-section at every station.
    Returns Y, Z arrays of shape (len(x), n_out), ordered deck centerline -> rail -> bottom centerline.
    """
    K = 900
    th = np.linspace(np.pi / 2, -np.pi / 2, K)[None, :]       # deck center -> apex -> bottom center
    h_ = h[:, None]; t_ = t[:, None]; zb_ = zb[:, None]

    ed = 1.7 + 1.4 * p.rail_fullness                           # deck superellipse exponent
    eb = (2.0 + 6.0 * rail_hardness(p, x))[:, None]            # bottom superellipse exponent
    ar = p.rail_apex
    z_apex = zb_ + ar * t_
    td, tb = (1 - ar) * t_, ar * t_

    c, s = np.cos(th), np.sin(th)
    deck = th >= 0
    e = np.where(deck, ed, eb)
    Yraw = h_ * np.abs(c) ** (2 / e)
    Z = np.where(deck, z_apex + td * np.abs(s) ** (2 / ed), z_apex - tb * np.abs(s) ** (2 / e))

    # Bottom contours as a function of eta = y/h
    eta = np.clip(Yraw / np.maximum(h_, 1e-9), 0, 1)
    con = concave_profile(p, x)[:, None] * (1 - eta ** 2) ** 2
    vee = vee_profile(p, x)[:, None] * (1 - eta)
    dome = 1 - 0.7 * p.deck_dome * eta ** 2
    Z = np.where(deck, z_apex + (Z - z_apex) * dome, Z + con - vee)

    # Swallow: squeeze the section between the notch wall and the rail
    Y = yin[:, None] + Yraw * (h_ - yin[:, None]) / np.maximum(h_, 1e-9)

    # Resample: arc length plus extra weight on turning angle, so hard rails stay crisp
    dY, dZ = np.diff(Y, axis=1), np.diff(Z, axis=1)
    ds = np.hypot(dY, dZ)
    ang = np.unwrap(np.arctan2(dZ, dY), axis=1)
    dturn = np.abs(np.diff(ang, axis=1, prepend=ang[:, :1]))
    w = ds + 0.35 * t_ * dturn
    cum = np.concatenate([np.zeros((len(x), 1)), np.cumsum(w, axis=1)], axis=1)

    Yo = np.empty((len(x), n_out)); Zo = np.empty((len(x), n_out))
    for i in range(len(x)):
        total = cum[i, -1]
        if total <= 1e-12:
            Yo[i] = Y[i, 0]; Zo[i] = Z[i, 0]
            continue
        target = np.linspace(0, total, n_out)
        Yo[i] = np.interp(target, cum[i], Y[i])
        Zo[i] = np.interp(target, cum[i], Z[i])
    return Yo, Zo


# ---------------------------------------------------------------------------
# Mesh
# ---------------------------------------------------------------------------

def _stations(p: BoardParams) -> np.ndarray:
    s = np.linspace(0, 1, p.stations)
    x = p.length * (0.55 * 0.5 * (1 - np.cos(np.pi * s)) + 0.45 * s)  # denser at the tips
    half = p.length / 2      # put a station exactly on every measured point
    extra = [12.0, p.length - 12.0, half + p.wide_point_offset, half + p.rocker_low_point,
             half + p.thickness_point_offset]
    if TAIL_TYPES[p.tail_type]["notch"]:
        extra.append(p.swallow_depth)
    x = np.unique(np.concatenate([x, extra]))
    return x[np.concatenate([[True], np.diff(x) > 1e-3])]    # no near-duplicate stations


def _mesh_volume(V: np.ndarray, F: np.ndarray) -> float:
    a, b, c = V[F[:, 0]], V[F[:, 1]], V[F[:, 2]]
    return float(np.einsum("ij,ij->i", a, np.cross(b, c)).sum() / 6.0)


def _mesh_area(V: np.ndarray, F: np.ndarray) -> float:
    a, b, c = V[F[:, 0]], V[F[:, 1]], V[F[:, 2]]
    return float(0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1).sum())


def _build_mesh(p: BoardParams, t_scale: float):
    x = _stations(p)
    h = half_width(p, x)
    yin = np.minimum(notch_half_width(p, x), h * 0.95)
    zb = rocker(p, x)
    t = thickness(p, x, h, t_scale)
    M = p.section_points
    Y, Z = _sections(p, x, h, yin, t, zb, M)

    verts: list[np.ndarray] = []
    nv = 0
    IR = np.zeros((len(x), M), dtype=np.int64)
    IL = np.zeros((len(x), M), dtype=np.int64)
    collapsed = h < 1e-6

    for i in range(len(x)):
        if collapsed[i]:
            verts.append(np.array([[x[i], 0.0, zb[i]]]))
            IR[i, :] = nv; IL[i, :] = nv; nv += 1
            continue
        right = np.column_stack([np.full(M, x[i]), Y[i], Z[i]])
        verts.append(right)
        IR[i] = np.arange(nv, nv + M); nv += M
        if yin[i] > 1e-9:          # notch: both centerline points are separate per side
            left = right.copy(); left[:, 1] *= -1
            verts.append(left)
            IL[i] = np.arange(nv, nv + M); nv += M
        else:                      # weld deck and bottom centerline points
            left = right[1:-1].copy(); left[:, 1] *= -1
            verts.append(left)
            IL[i, 0], IL[i, -1] = IR[i, 0], IR[i, -1]
            IL[i, 1:-1] = np.arange(nv, nv + M - 2); nv += M - 2
    V = np.vstack(verts)

    faces = []
    a, b = slice(0, -1), slice(1, None)
    for I, flip in ((IR, False), (IL, True)):
        q0, q1, q2, q3 = I[:-1, :-1], I[1:, :-1], I[1:, 1:], I[:-1, 1:]
        t1 = np.stack([q0, q1, q2], -1).reshape(-1, 3)
        t2 = np.stack([q0, q2, q3], -1).reshape(-1, 3)
        tri = np.vstack([t1, t2])
        faces.append(tri[:, ::-1] if flip else tri)

    # Swallow notch walls
    for i in range(len(x) - 1):
        if yin[i] > 1e-9 and not collapsed[i]:
            for I, flip in ((IR, False), (IL, True)):
                quad = [I[i, 0], I[i, -1], I[i + 1, -1], I[i + 1, 0]]
                tri = np.array([[quad[0], quad[1], quad[2]], [quad[0], quad[2], quad[3]]])
                faces.append(tri[:, ::-1] if flip else tri)

    # Tail cap (only when the tail end has width)
    extra_v = []
    if not collapsed[0]:
        for I, flip in ((IR, False), (IL, True)):
            ring = I[0]
            ctr = V[ring].mean(axis=0)
            ci = nv + len(extra_v); extra_v.append(ctr)
            tri = np.column_stack([np.full(M, ci), ring, np.roll(ring, -1)])
            faces.append(tri[:, ::-1] if flip else tri)
    if not collapsed[-1]:  # should not happen for real noses, but stay watertight
        for I, flip in ((IR, False), (IL, True)):
            ring = I[-1]
            ci = nv + len(extra_v); extra_v.append(V[ring].mean(axis=0))
            tri = np.column_stack([np.full(M, ci), np.roll(ring, -1), ring])
            faces.append(tri[:, ::-1] if flip else tri)
    if extra_v:
        V = np.vstack([V, np.array(extra_v)])

    F = np.vstack(faces)
    F = F[(F[:, 0] != F[:, 1]) & (F[:, 1] != F[:, 2]) & (F[:, 0] != F[:, 2])]
    vol = _mesh_volume(V, F)
    if vol < 0:
        F = F[:, ::-1]; vol = -vol
    return V, F, vol, dict(x=x, h=h, yin=yin, zb=zb, t=t, Y=Y, Z=Z)


@dataclass
class Board:
    params: BoardParams
    vertices: np.ndarray          # (N, 3) inches
    faces: np.ndarray             # (F, 3) int
    volume_l: float
    thickness_scale: float
    warnings: list[str] = field(default_factory=list)
    _profiles: dict = field(default_factory=dict, repr=False)

    # ---- summary numbers -------------------------------------------------
    def stats(self) -> dict:
        p, pr = self.params, self._profiles
        x, h, t = pr["x"], pr["h"], pr["t"]
        plan_area = float(np.trapezoid(2 * h - 2 * pr["yin"], x))
        L = p.length
        return dict(
            length_in=L,
            length_ftin=f"{int(L // 12)}'{L % 12:.1f}\"".replace(".0\"", "\""),
            width_in=float(2 * h.max()),
            thickness_in=float(t.max()),
            volume_l=self.volume_l,
            nose_width_12_in=float(2 * np.interp(L - 12, x, h)),
            tail_width_12_in=float(2 * np.interp(12, x, h)),
            plan_area_in2=plan_area,
            surface_area_in2=_mesh_area(self.vertices, self.faces),
            thickness_scale=self.thickness_scale,
            stations=self.station_table(),
            vertices=int(len(self.vertices)),
            triangles=int(len(self.faces)),
        )

    def station_table(self) -> list[dict]:
        """What you would measure on the finished board, nose -> tail."""
        p, pr = self.params, self._profiles
        x, L = pr["x"], self.params.length
        tail = TAIL_TYPES[p.tail_type]
        rows = []
        for label, xs in (("Nose tip", L), ('12" from nose', L - 12.0),
                          ("Wide point", L / 2 + p.wide_point_offset),
                          ('12" from tail', 12.0), ("Tail end", 0.0)):
            width = 2 * float(np.interp(xs, x, pr["h"]))
            if xs == 0.0 and not tail["closes"]:
                width = p.tail_block_width           # corner to corner, before the corners are rounded
            rows.append(dict(label=label, from_nose_in=L - xs, width_in=width,
                             rocker_in=float(np.interp(xs, x, pr["zb"])),
                             thickness_in=float(np.interp(xs, x, pr["t"]))))
        return rows

    def spec_sheet(self) -> str:
        """Plain-text spec sheet: overall dimensions plus the station table."""
        s, p = self.stats(), self.params
        name = lambda v: v.replace("_", " ")
        lines = [
            f"{fmt_ftin(s['length_in'])} x {fmt_in(s['width_in'])} x {fmt_in(s['thickness_in'])}   {s['volume_l']:.1f} L",
            f"nose: {name(p.nose_type)}    tail: {name(p.tail_type)}",
            "",
            f"{'Station':<16}{'From nose':>11}{'Width':>10}{'Rocker':>10}{'Thickness':>11}",
        ]
        for r in self.station_table():
            lines.append(f"{r['label']:<16}{fmt_ftin(r['from_nose_in']):>11}{fmt_in(r['width_in']):>10}"
                         f"{fmt_in(r['rocker_in']):>10}{fmt_in(r['thickness_in']):>11}")
        lines += [
            "",
            f"wide point   {fmt_in(p.wide_point_offset)} from center (+ = toward nose)",
            f"rocker low   {fmt_in(p.rocker_low_point)} from center",
            f"thick point  {fmt_in(p.thickness_point_offset)} from center",
            f"rails        apex {p.rail_apex:.0%} of thickness, fullness {p.rail_fullness:.2f}, deck dome {p.deck_dome:.2f}",
            f"bottom       concave {fmt_in(p.concave_depth)}, tail vee {fmt_in(p.vee_depth)}",
            f"plan area    {s['plan_area_in2']:.0f} sq in",
            "",
            'Inches to the nearest 1/16. Rocker is bottom height above a flat table touching the low point.',
        ]
        return "\n".join(lines) + "\n"

    # ---- 2D views for the UI ----------------------------------------------
    def curves(self) -> dict:
        pr = self._profiles
        x, h, yin, zb, t = pr["x"], pr["h"], pr["yin"], pr["zb"], pr["t"]
        L = self.params.length
        out = dict(
            outline=dict(x=x.tolist(), h=h.tolist(), yin=yin.tolist()),
            rocker=dict(x=x.tolist(), bottom=zb.tolist(), deck=(zb + t).tolist()),
            sections={},
        )
        center = pr["yin"] <= 1e-9          # stringer only exists outside a swallow notch
        out["stringer"] = dict(
            x=x[center].tolist(),
            deck=pr["Z"][center, 0].tolist(),
            bottom=pr["Z"][center, -1].tolist(),
        )
        for name, xs in (("tail_12", 12.0), ("center", L / 2), ("nose_12", L - 12.0)):
            i = int(np.argmin(np.abs(x - xs)))
            Yr, Zr = pr["Y"][i], pr["Z"][i]
            out["sections"][name] = dict(
                x=float(x[i]),
                y=(np.concatenate([Yr, -Yr[::-1]])).tolist(),
                z=(np.concatenate([Zr, Zr[::-1]]) - zb[i]).tolist(),
            )
        return out

    # ---- exports ------------------------------------------------------------
    def to_stl(self, units: str = "mm") -> bytes:
        s = 25.4 if units == "mm" else 1.0
        V = self.vertices * s
        tri = V[self.faces]
        n = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
        n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
        rec = np.zeros(len(self.faces), dtype=[("n", "<f4", 3), ("v", "<f4", (3, 3)), ("a", "<u2")])
        rec["n"] = n; rec["v"] = tri
        header = f"surfboard {self.params.length:.1f}in {self.volume_l:.2f}L units={units}".encode()
        return header.ljust(80, b" ")[:80] + np.uint32(len(rec)).tobytes() + rec.tobytes()

    def to_obj(self, units: str = "mm") -> str:
        s = 25.4 if units == "mm" else 1.0
        lines = [f"# surfboard, units={units}, volume={self.volume_l:.2f} L"]
        lines += [f"v {a*s:.5f} {b*s:.5f} {c*s:.5f}" for a, b, c in self.vertices]
        lines += [f"f {a+1} {b+1} {c+1}" for a, b, c in self.faces]
        return "\n".join(lines) + "\n"


def params_from_dict(d: dict) -> BoardParams:
    """
    Build BoardParams from loose input:
      * measurements may be strings in shaper notation ('19 3/4', "6'0\"")
      * designs saved by v1 (nose_kick / tail_kick / foil_fullness exponents instead of 12"
        rocker and thickness measurements) are converted so they keep the same shape
    """
    fields = BoardParams.__dataclass_fields__
    d = dict(d)
    for k, v in list(d.items()):
        if k in fields and fields[k].type == "float" and isinstance(v, str):
            d[k] = parse_inches(v)
    base = {**asdict(BoardParams()), **{k: v for k, v in d.items() if k in fields}}
    L = base["length"]
    xl, xt = L / 2 + base["rocker_low_point"], L / 2 + base["thickness_point_offset"]
    for side, nose in (("nose", True), ("tail", False)):
        if f"{side}_kick" in d and f"{side}_rocker_12" not in d:
            base[f"{side}_rocker_12"] = base[f"{side}_rocker"] * _u12(L, xl, nose) ** float(d[f"{side}_kick"])
        if "foil_fullness" in d and f"{side}_thickness_12" not in d:
            te = base[f"{side}_thickness"]
            base[f"{side}_thickness_12"] = te + (base["thickness"] - te) * (1 - _u12(L, xt, nose) ** float(d["foil_fullness"]))
    return BoardParams(**base)


def build_board(params: BoardParams | dict | None = None) -> Board:
    if params is None:
        params = BoardParams()
    elif isinstance(params, dict):
        params = params_from_dict(params)
    p, warnings = params.validated()

    scale = 1.0
    V, F, vol, prof = _build_mesh(p, scale)
    if p.lock_volume:
        target_in3 = p.target_volume / IN3_TO_L
        for _ in range(6):  # volume is nearly linear in the thickness scale
            scale *= target_in3 / vol
            scale = min(max(scale, 0.4), 2.5)
            V, F, vol, prof = _build_mesh(p, scale)
            if abs(vol - target_in3) / target_in3 < 1e-4:
                break
        if scale in (0.4, 2.5):
            warnings.append("target volume out of reach by scaling thickness alone")
    return Board(p, V, F, vol * IN3_TO_L, scale, warnings, prof)


def check_watertight(F: np.ndarray) -> tuple[bool, int, int]:
    """Every directed edge must be matched by exactly one opposite edge."""
    e = np.vstack([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]])
    fwd = {tuple(r) for r in e.tolist()}
    unmatched = sum((b, a) not in fwd for a, b in fwd)
    dup = len(e) - len(fwd)
    return unmatched == 0 and dup == 0, unmatched, dup
