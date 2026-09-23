// One-time, deterministic namespace migration from the frozen v0.2.59 checkout.
// Preserves GLB node metadata, entity IDs, math, and the frontend import order.
import { readFileSync, writeFileSync, readdirSync, renameSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const original = join(root, 'custom_components/ha3d');
const lab = join(root, 'custom_components/ha3d_lab');
if (!existsSync(original) || existsSync(lab)) throw Error('Requires an unmigrated baseline checkout');
function visit(dir) {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, item.name);
    if (item.isDirectory()) { visit(file); continue; }
    if (!/\.(js|mjs|py|json|yml)$/.test(item.name)) continue;
    const before = readFileSync(file, 'utf8');
    const after = before
      .replaceAll('custom_components/ha3d/', 'custom_components/ha3d_lab/')
      .replaceAll('custom_components/ha3d"', 'custom_components/ha3d_lab"')
      .replaceAll('custom_components/ha3d\n', 'custom_components/ha3d_lab\n')
      .replaceAll('ha3d-panel', 'ha3d-lab-panel')
      .replaceAll('ha3d_static', 'ha3d_lab_static')
      .replace(/(["'`/])ha3d\//g, '$1ha3d_lab/')
      .replaceAll('api:ha3d:', 'api:ha3d_lab:')
      .replace(/(["'])ha3d_((?!lab(?:_|\/))[\w])/g, '$1ha3d_lab_$2')
      .replace(/(["'])ha3d\1/g, '$1ha3d_lab$1');
    if (after !== before) writeFileSync(file, after);
  }
}
visit(original); visit(join(root, 'tests')); visit(join(root, '.github/workflows'));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
pkg.name = 'ha3d-lab'; pkg.version = '0.3.0-lab.1';
for (const key of Object.keys(pkg.scripts)) pkg.scripts[key] = pkg.scripts[key].replaceAll('custom_components/ha3d/', 'custom_components/ha3d_lab/');
writeFileSync(join(root, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
renameSync(original, lab);
const manifestPath = join(lab, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
Object.assign(manifest, { name: 'HA3D Lab', version: '0.3.0-lab.1', documentation: 'https://github.com/Jackson-Gomes/HA3D-Lab', issue_tracker: 'https://github.com/Jackson-Gomes/HA3D-Lab/issues' });
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
for (const [file, before, after] of [
  ['__init__.py', 'FRONTEND_VERSION = "0.2.59"', 'FRONTEND_VERSION = "0.3.0-lab.1"'],
  ['const.py', 'PANEL_TITLE: Final = "HA3D"', 'PANEL_TITLE: Final = "HA3D Lab"'],
  ['config_flow.py', 'title="HA3D"', 'title="HA3D Lab"'],
]) {
  const target = join(lab, file); writeFileSync(target, readFileSync(target, 'utf8').replaceAll(before, after));
}
const hacs = JSON.parse(readFileSync(join(root, 'hacs.json'), 'utf8')); hacs.name = 'HA3D Lab';
writeFileSync(join(root, 'hacs.json'), JSON.stringify(hacs, null, 2) + '\n');
console.log('Lab namespace isolated; original tag and GLB coordinate contracts preserved.');
