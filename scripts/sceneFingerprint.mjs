/**
 * Hash the observable custom-scene pipeline for every shipped example and the
 * legacy v1 bolt-bearing fixture.
 *
 *   node scripts/sceneFingerprint.mjs           compare to scripts/fixtures/scene-fingerprints.json
 *   node scripts/sceneFingerprint.mjs --write   record the current process as the baseline
 *
 * The hash covers, per load case, the little-endian bytes of fixedDofs and F,
 * the passive mask, auto working bounds rounded to 1e-9, and glyph descriptors
 * with `id` removed. Supports, bolt loads, and free loads must stay in that order
 * or the bytes change.
 */
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyCustomBCs } from '../src/scene/applyCustomBCs.js';
import { buildPassiveMask } from '../src/scene/passiveVoids.js';
import { sceneLoadCaseCount } from '../src/scene/pointLoad.js';
import { getCustomFixtureDescriptors } from '../src/scene/fixturesFromScene.js';
import { SCENE_EXAMPLES } from '../src/scene/templates.js';
import { normalizeScene } from '../src/scene/types.js';
import { computeAutoWorkingBounds } from '../src/scene/workingVolume.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = join(root, 'scripts', 'fixtures', 'scene-fingerprints.json');

const LEGACY_V1 = {
  version: 1,
  fixations: [
    { id: 'f1', type: 'bolt_hole', x: 0.2, y: 0.5, z: 0.5, radius: 0.05, axis: 'z', fixX: true, fixY: true, fixZ: true },
    { id: 'f2', type: 'bolt_hole', x: 0.8, y: 0.5, z: 0.5, radius: 0.05, axis: 'z', fixX: true, fixY: true, fixZ: true },
  ],
  forces: [
    { id: 'b1', type: 'bolt_bearing', x: 0.8, y: 0.5, z: 0.5, radius: 0.05, axis: 'z', fx: 0, fy: -1, fz: 0, magnitude: 1 },
  ],
  links: [{ id: 'l1', type: 'distance', aId: 'f1', bId: 'b1', distance: 0.6, axis: 'x' }],
};

function dimsOf(resolution) {
  const [nx, ny, nz] = (resolution ?? '36x15x8').split('x').map(Number);
  return { nx, ny, nz };
}

function bytesHex(view) {
  return Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString('hex');
}

function round1e9(v) {
  return Math.round(v * 1e9) / 1e9;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      if (value[k] === undefined) continue;
      out[k] = canonicalize(value[k]);
    }
    return out;
  }
  return value;
}

function stripGlyphIds(glyphs) {
  return glyphs.map((g) => {
    const { id, ...rest } = g;
    return canonicalize(rest);
  });
}

/** @param {import('../src/scene/types.js').Scene} scene @param {{nx:number,ny:number,nz:number}} dims */
export function fingerprintScene(scene, dims) {
  const { nx, ny, nz } = dims;
  const nNodes = (nx + 1) * (ny + 1) * (nz + 1);
  const cases = [];
  const nCases = sceneLoadCaseCount(scene);
  for (let k = 0; k < nCases; k++) {
    const fixedDofs = new Uint8Array(3 * nNodes);
    const F = new Float32Array(3 * nNodes);
    applyCustomBCs(fixedDofs, F, nx, ny, nz, scene, k);
    cases.push({ fixedDofs: bytesHex(fixedDofs), F: bytesHex(F) });
  }
  const mask = buildPassiveMask(nx, ny, nz, scene);
  const auto = computeAutoWorkingBounds(scene, scene.workingVolume?.padding ?? 0.06, dims);
  const glyphs = stripGlyphIds(getCustomFixtureDescriptors(scene, nx, ny, nz));
  const payload = {
    cases,
    mask: mask ? bytesHex(mask) : null,
    autoBounds: {
      x0: round1e9(auto.x0),
      x1: round1e9(auto.x1),
      y0: round1e9(auto.y0),
      y1: round1e9(auto.y1),
      z0: round1e9(auto.z0),
      z1: round1e9(auto.z1),
    },
    glyphs,
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function cases() {
  const out = SCENE_EXAMPLES.map((ex) => {
    const dims = dimsOf(ex.resolution);
    const scene = normalizeScene(ex.build());
    return { id: ex.id, dims: [dims.nx, dims.ny, dims.nz], sha256: fingerprintScene(scene, dims) };
  });
  const dims = dimsOf('36x15x8');
  out.push({
    id: 'legacy_v1_bolt_bearing',
    dims: [dims.nx, dims.ny, dims.nz],
    sha256: fingerprintScene(normalizeScene(JSON.parse(JSON.stringify(LEGACY_V1))), dims),
  });
  return out;
}

const write = process.argv.includes('--write');
const current = cases();

if (write) {
  mkdirSync(dirname(fixturePath), { recursive: true });
  const doc = {
    algorithm:
      'sha256 of JSON: per load case little-endian fixedDofs and F hex, passive mask hex or null, auto bounds rounded to 1e-9, glyphs with id removed and keys sorted',
    cases: current,
  };
  writeFileSync(fixturePath, `${JSON.stringify(doc, null, 2)}\n`);
  for (const c of current) console.log(`  wrote ${c.id} ${c.sha256.slice(0, 12)}`);
  console.log(`\nWrote ${current.length} hashes to ${fixturePath}`);
  process.exit(0);
}

let saved;
try {
  saved = JSON.parse(readFileSync(fixturePath, 'utf8'));
} catch {
  console.error(`Missing ${fixturePath}. Run with --write on unmodified trunk first.`);
  process.exit(1);
}

const byId = new Map((saved.cases ?? []).map((c) => [c.id, c]));
let failed = 0;
for (const c of current) {
  const prev = byId.get(c.id);
  const same = prev && prev.sha256 === c.sha256;
  if (!same) failed++;
  console.log(`  ${same ? 'ok' : 'DIFF'} ${c.id} ${c.sha256.slice(0, 12)}${prev ? '' : ' (missing baseline)'}`);
}
const extra = (saved.cases ?? []).filter((c) => !current.some((x) => x.id === c.id));
for (const c of extra) {
  failed++;
  console.log(`  DIFF ${c.id} baseline has no current case`);
}
if (failed) {
  console.error(`\n${failed} fingerprint(s) differ from the baseline.`);
  process.exit(1);
}
console.log(`\n${current.length} fingerprints match.`);
