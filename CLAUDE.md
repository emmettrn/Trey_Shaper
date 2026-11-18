# Notes for Claude (and anyone picking up this project)

Read this first. README.md has the user guide and the math, CONTRIBUTING.md has the rules for
changes. This file adds what an AI assistant needs to work on the code well.

## What this is

A parametric surfboard design tool that runs entirely in the browser. A shaper types the
measurements of a board, picks nose and tail types, refines the curves with anchor points and
reads the result as a 3D view, plan / profile / cross-section graphs, a spec sheet and STL / OBJ.

- Live site: https://emmettrn.github.io/trey_shaper/ (GitHub Pages, published from `docs/` by
  `.github/workflows/pages.yml`)
- Users are shapers who know boards well and are not programmers. UI text uses their words
  (rocker, foil, rail apex, concave, vee) and stays plain.

## Where things are

```
docs/                 the web app, exactly what the site serves. No build step, no subfolders.
  index.html, style.css, app.js (UI), geometry.js (board math), data.js (generated)
  sw.js, manifest.webmanifest, icon-*.png      home-screen install and offline use
  three.module.min.js + 3 three.js add-ons     bundled, r170 (license: three-LICENSE.txt)
surfboard/            Python reference implementation of the same math
tools/build_data.py   writes docs/data.js from the Python package
tests/                test_geometry.py (Python), test_js_parity.py (JS against Python)
app.py                optional local server with a Python API
```

## Working rules

Follow every rule in CONTRIBUTING.md. In short: change `surfboard/geometry.py` and
`docs/geometry.js` together, run both test files before calling anything done, regenerate
`docs/data.js` with `python tools/build_data.py` after changing presets or controls, keep
`docs/` flat, bump the cache name in `docs/sw.js`, keep old saved designs loading, and never
let a shape edit change a measurement the shaper typed.

Check a UI change in a real browser before shipping: the 3D view, all three graphs with Edit
points on and off, undo / redo, and a saved design loading.

## Scope decisions

- Fin placement is out of scope for now (done with a jig after shaping).
- A rider-to-board suggestion page was built and removed on purpose. Do not bring it back
  unasked.
- Blank fitting needs a real blank maker's catalog dimensions. Do not invent them.
- CNC export format is not chosen yet.

## Shipping

Work on a branch and open a pull request; the owner (emmettrn) merges. Merging to `main`
publishes the site in a minute or two.
