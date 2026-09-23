# HA3D Lab — 0.3.0-lab.1

Experimental development line forked from **v0.2.59**, commit
`ddd5eea57630a4c04026ca53dfc13f80a6a030ca`. This repository is independent of
Jackson-Gomes/HA3D; no automatic upstream merges or stable releases.

## Parallel installation

Install only `custom_components/ha3d_lab` into your Home Assistant configuration,
then restart HA when convenient and add the **HA3D Lab** integration. This release
is a prototype; live HA installation has not been exercised by the automated fixtures.

| Resource | Stable | Lab |
| --- | --- | --- |
| Integration/storage key | ha3d | ha3d_lab |
| Panel URL | /ha3d | /ha3d_lab |
| Custom element | ha3d-panel | ha3d-lab-panel |
| API | /api/ha3d/ | /api/ha3d_lab/ |
| Static frontend | /ha3d_static | /ha3d_lab_static |
| Model and asset files | www/ha3d/ | www/ha3d_lab/ |
| Browser preferences | ha3d_* | ha3d_lab_* |

The Lab starts with empty configuration. Upload a separate GLB copy through its
own panel. Do not rename/move the stable component or its data. Neither installation
is performed by the repository tests. Both viewers can operate the same HA entities
when explicitly configured: namespace isolation is not a separate Home Assistant.

## Changes and verification

1. Isolated integration namespace, routes, uploads, storage, custom element and
   browser preference keys. Kept GLB metadata, entity IDs, calibration math and
   import order unchanged. Removed inherited stable release workflow in this repo.
2. Namespace checks: frontend syntax, 9 calibration tests and 7 Python schema
   tests passed locally. Live HA/backend and real mobile validation remain pending.

## Development

`pnpm install --frozen-lockfile`, `pnpm run check`, `pnpm test`,
`python -m unittest discover -s tests -p 'test_*.py'`.

`scripts/isolate-lab.mjs` records the one-time mechanical namespace migration and
refuses to run again. The frozen baseline is available through git history and
the original upstream tag. Releases from this repository must use `-lab.N`.
