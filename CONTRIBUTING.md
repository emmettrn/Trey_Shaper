# Contributing

Thanks for helping with Trey Shaper. This page is the short version of how to work on it.

## Setup

You need Python 3.10+ and Node 18+.

```bash
git clone https://github.com/emmettrn/trey_shaper.git
cd trey_shaper
pip install -r requirements.txt
cd docs && python -m http.server 8000     # open http://localhost:8000
```

On Windows, [GitHub Desktop](https://desktop.github.com/) is the easiest way to clone, commit and
open pull requests.

## How changes get in

1. Make a branch for your change (for example `outline-handles` or `fix-rocker-export`).
2. Commit in small steps, each with a message that says what changed and why.
3. Open a pull request into `main`. The **Tests** check runs automatically.
4. The owner (emmettrn) reviews and merges. Merging to `main` publishes the site.

Report bugs and ideas in [Issues](https://github.com/emmettrn/trey_shaper/issues).

## Rules that keep it working

1. **Two copies of the math, kept identical.** `surfboard/geometry.py` is the reference and
   `docs/geometry.js` is a line-for-line port. Change both in the same pull request.
2. **Run both tests before opening a pull request.**
   ```bash
   python tests/test_geometry.py
   python tests/test_js_parity.py
   ```
3. **`docs/data.js` is generated.** After changing defaults, presets or the controls
   (`presets.py`, `schema.py`, `BoardParams`), run `python tools/build_data.py`.
4. **Keep `docs/` flat** (no subfolders), so it still works when files are uploaded through
   the GitHub website.
5. **Bump the cache name in `docs/sw.js`** (`surfboard-designer-vN`) whenever a site file
   changes, so installed copies update.
6. **Old saved designs must still load.** If a parameter changes meaning, convert old values
   on load (`applyParams` in `app.js`, `params_from_dict` in Python).
7. **Measurements are sacred.** A number the shaper typed must come out exactly in the spec
   sheet. Shape edits change the curve between measurements, never the measurements.

## Words used in the code

- **Station**: one of the five standard measurement points (nose tip, 12" from nose, wide /
  low / thick point, 12" from tail, tail end).
- **Mark**: an added measurement anywhere else.
- **Anchor**: a point added to a curve, with a **handle** (slope plus two arm lengths).
- **Slice**: a cross section placed by the user to shape.
- Board space is inches: x from the tail along the stringer, y across, z up.
