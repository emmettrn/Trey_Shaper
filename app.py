"""
Local server for Surfboard Designer.

The web app in docs/ runs entirely in the browser (it is what GitHub Pages hosts), so this
server is optional: it serves docs/ for local use and offers the Python geometry as an API
for scripts.

    pip install -r requirements.txt
    python app.py            # then open http://localhost:8000
"""
from __future__ import annotations

import base64
import time
from dataclasses import asdict
from pathlib import Path

import numpy as np
from fastapi import FastAPI, Body
from fastapi.responses import Response, JSONResponse
from fastapi.staticfiles import StaticFiles

from surfboard import BoardParams, build_board, PRESETS
from surfboard.schema import GROUPS, STATION_TABLE

ROOT = Path(__file__).parent
SITE = ROOT / "docs"          # the web app; it runs entirely in the browser

app = FastAPI(title="Surfboard Designer")


@app.get("/api/schema")
def schema():
    return dict(groups=GROUPS, station_table=STATION_TABLE, defaults=asdict(BoardParams()), presets=PRESETS)


def _b64(a: np.ndarray) -> str:
    return base64.b64encode(np.ascontiguousarray(a).tobytes()).decode()


@app.post("/api/board")
def board(params: dict = Body(...)):
    t0 = time.perf_counter()
    b = build_board(params)
    return dict(
        params=asdict(b.params),
        stats=b.stats(),
        warnings=b.warnings,
        curves=b.curves(),
        mesh=dict(
            positions=_b64(b.vertices.astype("<f4")),
            indices=_b64(b.faces.astype("<u4")),
        ),
        build_ms=round((time.perf_counter() - t0) * 1000, 1),
    )


EXPORT_MESH = dict(stations=321, section_points=96)   # finer than the on-screen preview


@app.post("/api/export")
def export(params: dict = Body(...), format: str = "stl", units: str = "mm"):
    b = build_board({**params, **EXPORT_MESH})
    name = f"surfboard_{b.stats()['length_ftin'].replace(chr(39), 'ft').replace(chr(34), 'in')}_{b.volume_l:.1f}L"
    if format == "stl":
        return Response(b.to_stl(units), media_type="model/stl",
                        headers={"Content-Disposition": f'attachment; filename="{name}.stl"'})
    if format == "obj":
        return Response(b.to_obj(units), media_type="text/plain",
                        headers={"Content-Disposition": f'attachment; filename="{name}.obj"'})
    if format == "txt":
        return Response(b.spec_sheet(), media_type="text/plain",
                        headers={"Content-Disposition": f'attachment; filename="{name}_spec.txt"'})
    return JSONResponse({"error": f"unknown format {format}"}, status_code=400)


# Static site last, so /api/* routes win
app.mount("/", StaticFiles(directory=SITE, html=True), name="site")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)
