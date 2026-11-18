// Reads a JSON list of designs on stdin, builds each with docs/geometry.js, prints results as JSON.
import { buildBoard, checkWatertight, specSheet } from '../docs/geometry.js';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const out = JSON.parse(input).map((d) => {
  const b = buildBoard(d);
  return {
    volume_l: b.volume_l, warnings: b.warnings, thickness_scale: b.thickness_scale,
    vertices: b.stats.vertices, triangles: b.stats.triangles, stations: b.stats.stations,
    plan_area_in2: b.stats.plan_area_in2, surface_area_in2: b.stats.surface_area_in2,
    watertight: checkWatertight(b.faces)[0], spec: specSheet(b), ms: b.build_ms,
  };
});
process.stdout.write(JSON.stringify(out));
