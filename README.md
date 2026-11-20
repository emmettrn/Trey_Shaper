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

## Round 7

- **Edited cross sections lead.** A setting you change on a cross section is pinned there; the board
  runs through your edited sections as one smooth curve and the rest of the board is generated
  around them. A setting you did not touch on a section is not pinned (it follows its neighbours),
  so lowering the rail apex at T4" no longer snaps back at a T2" section you only changed the tuck
  on. Past the last edited section the change eases out toward the tip: kept almost whole when the
  section is near the tip (the apex releases out the tail), faded out within 24" when it is far.
  Edited sections are orange on the Plan and Profile graphs and in the Skeleton view, and in the
  section editor the settings you set there are marked orange.
- **Swallow** sliders are in **Foil**. New **Swallow inside rail**: each half of the swallow rolls into
  its own rail on the inside of the cut (0 = a square wall, 1 = deck and bottom meet at the apex
  height), so each half foils like a small tail.
- **Deck contours** (Foil section): deck concave (the deck rises toward the rails, the stringer stays
  on your thickness), deck vee (a ridge on the stringer), deck channels (1 to 4 a side), step deck
  (a band along each rail cut down, with the step a set distance in from the rail) and step tail
  (the whole deck steps down across the board). Each runs from one spot to another and eases in and
  out over the inches you set at each end; 0 is a crisp step. They show as bands on the Plan graph.

## Round 5

- **Vee** keeps the stringer on the rocker and lifts the rails (it used to drop the stringer
  below the rocker, which also made a divot where a vee met a single concave).
- **Single concave** is one dish across the bottom (the old curve flattened toward the rail and
  read as two under the bay lights).
- **Bay lights**: a soft warm lamp on one rail, a soft cool one on the other, plus a dim overhead
  lamp and a brighter-from-above fill for natural shading. A concave's colours cross over at the
  stringer; a vee's or a roll's stay on their own side; flat foam stays dim. The fixed light
  starts lower (about 10 degrees) so slight contours show.
- **Concave tools**: edges rounded over 1/10" and a finer mesh (at least 96 points round each
  section), so edges read crisp without stair-stepping or ripples. An edge dragged past the
  outline runs the concave off the rail, lifting the rail there (a step in the edge). Ends can run
  past the nose or tail; straight-edge widths can be wider than the board, so any angle works.
- **Swallow tip**: selecting the tail end shows two arms, one for the outline and one for the cut.
- Short arms are drawn at least 16 px out so they can be grabbed.

## Rails: tuck in inches (round 4)

The old Rail edge sliders (0 to 1) are now **Nose rail tuck** and **Tail rail tuck**, in inches:
how far in from the rail apex the rail turns under to the flat bottom. 0" drops straight down
from the apex; 1/2" is a firm rail; 3" is very soft, and the upturn never reaches further in than
that. **Hard edge (tail)** makes the tail's tuck end in a corner instead of meeting the bottom
smoothly. **Tail tuck reaches** and **Nose tuck reaches** set how far up the board each end's tuck
(and the hard edge) holds before blending into the other. In the section editor, **Rail tuck**
and **Edge** (0 soft, 1 hard) change one section, and the orange edge point drags the tuck in or
out. Designs saved earlier are converted when they load.

Every cross section is now sampled the same way (the apex and the edge always on the same mesh
points, the flat bottom evenly), so rails, the stringer line and concave edges no longer ripple.
Concave tools stay on the flat bottom, clear of the rail's tuck. A concave that runs out the tail
or nose holds its depth out by default; its blend slider eases it out flat at that end.

The 3D view is back to the original orbit (no flipping at the top or bottom); use Bottom up to
see the bottom.

## November 18 update (round 3)

- **3D view:** the old orbit control is back. Dragging past straight above or below turns the
  board over (like Bottom up), so you can still go all the way around.
- **Photo trace:** finds a swallow cut (depth and width, pointed or rounded tips). On the fix
  screen the nose and tail end points move (the length follows) and have arms; a swallow's V has
  two points of its own, and buttons add or remove the cut.
- **Swallow tips** slider: 0 makes each side of a swallow come to a point.
- **Swallow tip radius** (Outline, swallows only): rounds the deck down toward the rail over that
  many inches at each tip, like a rail radius on the swallow's ends. 0 keeps square ends.
- **Nose tip and tail end arms** on the Plan graph: click the square at either tip to shape how
  the outline leaves it (blunter or more pointed). The 12" widths and the width do not move.
- **Concave tools:** tear drop and venturi edges are curves through points with arms (click a
  point for its arms, click an edge to add a point). The tear drop starts rounder.
- **Deepest spot and blends:** every concave tool and every contour stretch has a "deepest at"
  box (or drag the small triangle on the Plan graph) and two sliders that ease the depth out toward
  the nose and toward the tail. Left holds full depth to the end; right eases all the way.
- **Overlapping contours** combine (each spot takes the stronger of each contour) instead of
  cutting into each other.
- **Added measurements** go into the measurement table itself, in order nose to tail.
- **Hard rails:** past 0.3, Rail edge turns into a tucked edge: the bottom runs flat to a real
  corner at 1, with a rounded tuck up to the apex. **Edge tuck** (Rails, and per section) sets how
  far the edge sits in under the apex; in the section editor drag the orange **edge** point. Apex
  arms now reach the whole side, so a rail can always be rounded right into the apex.

## Tracing an outline from a photo

**Trace photo** on the Plan graph makes the outline from a photo of a board (or a template on
paper). Shoot it from straight above on a floor that contrasts with it. Tap the nose tip and
the tail end, check the length, then **Trace**. It finds the edge on one side (the board is
symmetric, so the other side is its mirror; **Trace the other side** uses the other edge) and
asks *Does this look good?* **Yes** uses it; **No, fix it** shows points on the line to drag
onto the edge (click the line to add one, double-click to remove one). The design is then
fitted: width, wide point, the widths 12" from each end, tail block, nose and tail type, and
outline anchor points for everything in between. The straightened photo stays behind the Plan
graph (**Photo** turns it on and off) until the page is reloaded. The photo never leaves the
device. Only the outline comes from a photo; rocker, foil and rails still come from your numbers.

## Positions

Wherever a spot on the board is typed (added measurements, bottom stations, concave tools) it
can be measured from the nose, from the tail, or ahead of / behind center.

## Bottom: three ways

1. **Contour stations** (blended): say what the bottom does at a few spots and it is blended
   in between. A station can be a stretch, with **until…**: "single concave 1/8" from 3" off
   the nose until 1" behind center" holds that contour the whole way, then blends toward the
   stations either side.
2. **Concave tools** (hard edges): **+ Tear drop**, **+ Straight edges** or **+ Venturi**, each
   single or double. The edges of the concave are creases, not blends; a double can be hard on
   both sides or only on the rail side (blending into the ridge). **Shape it on the Plan graph**
   puts handles on it: diamonds move its ends, dots move its edges.
   - **Center line** (on each tool's card) sets the rocker along the stringer inside the concave,
     separate from the rail-line rocker:
     *blended* uses the deepest spot and the two blend sliders (a blend of 0 now gives a kink in
     the rocker at that end instead of a step); *flat* runs the stringer straight from one end
     of the tool to the other, so the rocker kinks at both ends; *custom* lets you draw it on the
     Profile graph (drag points up to go deeper, click the line to add one; each point is a
     kink). For a nose concave that exits straight out the rocker, put the nose end point at 0.
   - *Tear drop*: the noserider nose concave: round at one end (following the rails near the
     nose), tapering to a point, deepest a third of the way along.
   - *Straight edges*: set the width at each end: equal widths are parallel, different widths
     converge or spread (the box shows the angle).
   - *Venturi*: curved edges you shape with points, like the double concaves of a Bonzer
     through the tail (pinched in the middle, flaring out the tail).
3. **By hand** on any cross section (Sections graph, **Edit here**).

## 3D view

The board turns freely all the way around (end over end, past straight above and below), also
with **Bottom up**. The view buttons set it upright again.

## Sections, light and layout

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
