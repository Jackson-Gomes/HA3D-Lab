import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const root = resolve(import.meta.dirname, '..');
const component = resolve(root, 'custom_components/ha3d_lab');
let checked = 0;
function visit(dir) {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, item.name);
    if (item.isDirectory()) { if (item.name !== '__pycache__') visit(path); continue; }
    if (!/\.(js|py|json)$/.test(path)) continue;
    const source = readFileSync(path, 'utf8');
    assert.ok(!/ha3d_lab_lab|\/api\/ha3d\/|["']ha3d\//.test(source), `Incorrect namespace: ${path}`);
    if (path.endsWith('.js')) {
      execFileSync(process.execPath, ['--check', path]); checked++;
      for (const match of source.matchAll(/(?:import|from)\s*["'](\.\/?[^"']+)["']/g)) {
        assert.ok(existsSync(resolve(dirname(path), match[1].split('?')[0])), `Missing import: ${path} -> ${match[1]}`);
      }
    }
    if (path.endsWith('.json')) JSON.parse(source);
  }
}
visit(component);
const manifest = JSON.parse(readFileSync(resolve(component, 'manifest.json')));
assert.equal(manifest.domain, 'ha3d_lab'); assert.match(manifest.version, /^0\.3\.0-lab\.\d+$/);
assert.ok(!existsSync(resolve(root, 'custom_components/ha3d')));
console.log(`${checked} frontend modules: syntax, local imports, namespace and JSON validated.`);
