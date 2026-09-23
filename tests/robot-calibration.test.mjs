import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

// Pure numerical regression tests; no Home Assistant connection or renderer.
const source = readFileSync(new URL("../custom_components/ha3d_lab/frontend/ha3d-robot-trackers.js", import.meta.url), "utf8");
class Vector3 { constructor(x = 0, y = 0, z = 0) { Object.assign(this, { x, y, z }); } }
class Panel {}
Panel.HA3D_THREE = { Vector3, MathUtils: { degToRad: (x) => x * Math.PI / 180 } };
const context = vm.createContext({ customElements: { get: () => Panel } });
vm.runInContext(source + "\nglobalThis.api = { transformFor, mapPosition, mapHeading, calibrationProblem, calibrationPoints, previewPosition, floorVector, getPosition, preferredPositionEntity };", context);
const api = context.api;
const close = (actual, expected, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const fit = (raw, fn) => ({ points: raw.map(([x, y]) => ({ raw: [x, y], model: fn(x, y) })) });
const refs = [[0, 0], [1000, 0], [0, 1000], [1000, 1000]];

test("A/B is a preview, C enables an automatic affine fit", () => {
  const c = fit(refs.slice(0, 2), (x, y) => [x / 1000 + 3, y / 1000 - 2]);
  assert.equal(api.transformFor(c), null);
  const p = api.previewPosition({ x: 0, y: 1000 }, c);
  close(p.x, 3); close(p.z, -1);
  c.points.push({ raw: [0, 1000], model: [3, -1] });
  assert.ok(api.transformFor(c));
});
test("fit automatically handles rotated/reflected axes and unequal scales", () => {
  const c = fit(refs, (x, y) => [4 - y / 1000, -2 - x / 500]);
  const p = api.mapPosition({ x: 250, y: 750 }, c);
  close(p.x, 3.25); close(p.z, -2.5); close(p.y, 0);
  close(api.transformFor(c).error, 0);
});
test("all points affect least-squares fit; an outlier raises residual error", () => {
  const c = fit(refs, (x, y) => [x / 1000, y / 1000]);
  c.points.push({ raw: [500, 500], model: [0.75, 0.5] });
  const p = api.mapPosition({ x: 500, y: 500 }, c);
  close(p.x, 0.55); close(p.z, 0.5); close(api.transformFor(c).error, 0.1);
});
test("same sensor positions, collinear references and collapsed model cannot calibrate", () => {
  for (const c of [fit([[1, 1], [1, 1], [1, 1]], () => [1, 1]), fit([[0, 0], [1, 1], [2, 2]], (x, y) => [x, y]), fit(refs, () => [0, 0])]) assert.equal(api.transformFor(c), null);
});
test("legacy A/B and inversion settings remain readable", () => {
  const c = { raw_a: [0, 0], model_a: [2, 3], raw_b: [1000, 0], model_b: [3, 3], invert_y: true };
  const p = api.mapPosition({ x: 500, y: 500 }, c);
  close(p.x, 2.5); close(p.z, 2.5);
  assert.equal(api.calibrationPoints(c).length, 2);
});
test("initial sphere uses sensor coordinates, then first corrected anchor", () => {
  let p = api.previewPosition({ x: 1000, y: -2000 }, { points: [] });
  close(p.x, 1); close(p.z, -2);
  p = api.previewPosition({ x: 2000, y: -2000 }, { points: [{ raw: [1000, -2000], model: [5, 7] }] });
  close(p.x, 6); close(p.z, 7);
});
test("sensor movement never changes the fixed height on any selected plane", () => {
  for (const [plane, heightAxis] of [["xz", "y"], ["xy", "z"], ["yz", "x"]]) {
    for (const [u, v] of [[0, 0], [-8, 1234], [999, -678]]) close(api.floorVector(u, v, 1.25, plane)[heightAxis], 1.25);
  }
});
test("heading follows the fitted direction of the icon's -Z axis", () => {
  const c = fit(refs, (x, y) => [x / 1000, y / 1000]);
  const h = api.mapHeading(0, c);
  close(-Math.sin(h), 1); close(-Math.cos(h), 0);
});
test("autodetection favors XY sensor only on a new robot and preserves a saved choice", () => {
  const hass = { states: { "sensor.wrong_position": { state: "unknown" }, "sensor.other_vacuum_position": { state: '{"x":1,"y":2}', attributes: {} } } };
  assert.equal(api.preferredPositionEntity(hass), "sensor.other_vacuum_position");
  assert.equal(api.preferredPositionEntity(hass, "sensor.wrong_position"), "sensor.wrong_position");
});
