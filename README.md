# Trey Shaper: parametric surfboard designer

[![Tests](https://github.com/emmettrn/trey_shaper/actions/workflows/tests.yml/badge.svg)](https://github.com/emmettrn/trey_shaper/actions/workflows/tests.yml)
[![Deploy site](https://github.com/emmettrn/trey_shaper/actions/workflows/pages.yml/badge.svg)](https://github.com/emmettrn/trey_shaper/actions/workflows/pages.yml)

**Live app: https://emmettrn.github.io/Trey_Shaper/**

Design a surfboard from the measurements a shaper takes (width, rocker and thickness at five
stations) plus nose type, tail type, rails and bottom contours, then refine the curves with
anchor points. The board shows up live as a 3D view, plan / profile / cross-section graphs and
a spec sheet, and exports to STL / OBJ.

The whole app runs in the browser (three.js), so there is nothing to install. A Python
package holds the reference version of the board math, and the tests check that the two agree.

## Try it

Open **https://emmettrn.github.io/Trey_Shaper/** on a computer, phone or iPad. On a phone you
can add it to the home screen and it works offline.

Use the **Feedback** button in the app to write notes. It copies them, together with the board
you have open, so you can paste them into a text or email.

### How the site is published

`.github/workflows/pages.yml` publishes the `docs/` folder to GitHub Pages whenever it changes
on `main` (repo **Settings → Pages → Source: GitHub Actions**). The site updates a minute or
two after a push.

## Run it on your own computer

Any static file server works, for example:

```bash
cd docs
python -m http.server 8000
# open http://localhost:8000
```

`python app.py` (after `pip install -r requirements.txt`) also serves the app, plus the Python
geometry as an API at `/api/board` and `/api/export` for scripts.

Tests (the second one needs Node 18+):

```bash
python tests/test_geometry.py
python tests/test_js_parity.py
```

## Entering a board

The **Measurements** table at the top of the sidebar takes the numbers straight off a board
or a spec sheet. Fractions are fine: `19 3/4`, `19-3/4`, `6'2"`, `1.9`.

| Station | Width | Rocker | Thickness |
|---|---|---|---|
| Nose tip | set by nose type | height at the tip | tip thickness |
| 12" from nose | N12 width | rocker at 12" | thickness at 12" |
| Wide point | max width | 0 (low point) | max thickness |
| 12" from tail | T12 width | rocker at 12" | thickness at 12" |
| Tail end | tail block width, or set by tail type | height at the tail | tail thickness |

Rocker is the height of the bottom above a flat table that touches the low point.

The sliders below the table edit the same numbers. Typing a number is literal. Dragging an
end slider (nose rocker, tail rocker, thickness) keeps the curve's shape, so its 12" value
follows along.

If a measurement can't be reached by a fair curve (for example more rocker at 12" than at
the tip), it is limited to the nearest value that can, and a warning chip says so.

## 3D view, sections and layout

- **Rail apex point.** While shaping a cross section (Sections graph, **Edit here**), each rail
  apex has a point of its own (a ring with up / down ticks). Drag it up or down to set the apex
  height of that section. It cannot move in or out, because the width belongs to the outline.
  Double-click it to go back to the board-wide height. Click it to show its two **arms**, one
  toward the deck and one toward the bottom. Each has its own angle and length: upright arms
  give a round rail, arms angled in make the deck and bottom meet at a point (a pinched rail),
  and the length sets how far the rail holds that line before rolling back into its usual
  shape. Double-click an arm to put that side back. Like everything a section changes, the
  pinch blends out toward the neighbouring sections and the tips.
- **Fixed light.** With Bay lights and Fixed light on, the **Light** pad in the corner of the 3D
  view moves the lamp: drag the dot (the rim is side-on and raking, the middle lights the board
  straight on). The ball shows how the light falls. Double-click the pad to reset it.
- **Bottom up** sits with 3/4, Top, Side and Tail, and turns the board over.
- **Resizing.** Drag the dividers between the sidebar and the views, between the 3D view and the
  graphs, and between the graphs. Double-click a divider to put it back. The layout is
  remembered. On phones the views stack, so there are no dividers.

## Layout

```
docs/               the web app (what GitHub Pages serves)
  index.html, style.css
  app.js            UI, three.js viewer, 2D panels, exports, feedback form
  geometry.js       the board math, a port of surfboard/geometry.py
  data.js           defaults, presets and UI controls, generated from the Python package
surfboard/          Python reference implementation
  geometry.py       outline, rocker, foil, rail sections, mesh, volume, exports
  units.py          feet / inches / fractions parsing and formatting
  presets.py        starting-point boards
  schema.py         UI definitions: the measurement table and the slider groups
tools/build_data.py regenerates docs/data.js
app.py              optional local server + Python API
tests/
```

The Python code is the reference. `docs/geometry.js` mirrors it line for line, and
`tests/test_js_parity.py` builds every preset plus 60 random boards both ways and checks they
agree (volume to about $10^{-14}$, identical station table, warnings and spec sheet).

To add a design parameter: add a field to `BoardParams`, use it in `geometry.py` **and**
`docs/geometry.js`, add one entry to `schema.py`, then run `python tools/build_data.py`.

## Using it from Python directly

```python
from surfboard import build_board

b = build_board(dict(length="6'2\"", width="19 3/4", nose_rocker="5 1/4", nose_rocker_12="1 3/4",
                     tail_type="swallow", nose_type="round"))
print(b.spec_sheet())                      # overall dimensions + station table
open("board.stl", "wb").write(b.to_stl(units="mm"))
```

## Geometry model

Board space is in inches: $x$ along the stringer (0 = tail, $L$ = nose), $y$ across, $z$ up.

Every curve has one free shape exponent per side, solved in closed form so the curve passes
through the 12" measurement exactly. Because each side is a single power curve it cannot
overshoot, wiggle or change the sign of its curvature. In each formula $u$ runs from 0 at
the curve's origin (wide point, low point or thick point) to 1 at the end of the board, and
$u_{12}$ is the position of the 12" station.

**Outline.** With max half-width $W/2$ at the wide point,

$$h(u) = \tfrac{W}{2}\left(1 - u^{a}\right)^{1/b}, \qquad a = \frac{\ln\left(1 - r^{b}\right)}{\ln u_{12}}, \qquad r = \frac{N_{12}}{W}$$

where $b$ sets the nose type (1 pointed, 1.4 semi-pointed, 2 round, 3 blunt). The tail side
is the same with an offset for the tail block width, plus corner rounding (square, squash,
swallow) or full closure (round, rounded pin, pin).

**Rocker.** With tip rocker $R$ and rocker $r_{12}$ at the 12" station,

$$z_b(u) = R\,u^{k}, \qquad k = \frac{\ln\left(r_{12}/R\right)}{\ln u_{12}}$$

**Foil.** With max thickness $T$, end thickness $t_e$ and thickness $t_{12}$ at the 12" station,

$$t(u) = t_e + (T - t_e)\left(1 - u^{p}\right), \qquad p = \frac{\ln\left(1 - \frac{t_{12} - t_e}{T - t_e}\right)}{\ln u_{12}}$$

then pinched by $\tanh(1.5\,h/t)$ so the tips close cleanly.

**Rail sections.** Each station is two superellipses meeting at the rail apex (height
`rail_apex` $\times\ t$). Deck exponent comes from `rail_fullness`, bottom exponent from rail
hardness (blended nose to tail), deck dome thins the rails, and concave/vee are added across
the bottom. Points are resampled by arc length weighted toward high curvature so the rail
edge stays crisp instead of faceted.

**Mesh and volume.** Stations are lofted into a watertight triangle mesh (welded stringer
seam, capped tail, side walls for swallow notches). Volume comes from the divergence theorem,

$$V = \frac{1}{6}\sum_{\text{tris}} \mathbf{v}_0 \cdot (\mathbf{v}_1 \times \mathbf{v}_2)$$

and *Lock volume* rescales the foil iteratively until $V$ hits the target. Exports use a
finer mesh (about 120k triangles) than the on-screen preview (about 30k).

## What came from surfboard_cad_v3.py

- The station table as the way to enter a board, and the measurement table as output
  (now the spec sheet export).
- Feet / inches / fraction parsing (`units.py`).
- A finer mesh for export than for preview.
- Its example board, as the preset "Round pin 6'0" (v3 example)". The two programs agree on
  its volume to within 2% (29.5 L there, 29.0 L here, with different rail shapes).

What changed: the minimum-bending spline was replaced by the closed-form curves above
(the spline overshot the wide point on parallel-railed boards and dipped below the table
on flat rockers), the wide / low / thick points can move off center, nose and tail types
were added, rails are sampled evenly, and the tkinter + matplotlib window became the
browser UI. Designs saved by the first version of this app (with `nose_kick`,
`tail_kick`, `foil_fullness`) still load and keep their shape.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to set up, the rules that keep the Python and
JavaScript geometry in sync, and how changes get merged.

## Ideas for next steps

- Double concave, channels, chines
- Overlay two designs to compare
- Curvature plot of the outline and rocker to catch flat spots
- Export to shaping-machine formats
