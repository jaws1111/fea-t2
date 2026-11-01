import {
  createEmptyScene,
  createComponent,
  createLoadedHole,
  isSceneEmpty,
  normalizeScene,
} from '../scene/types.js';
import { componentDef, FAMILIES } from '../scene/components/index.js';
import { listRecipes } from '../library/store.js';
import {
  computeAutoWorkingBounds,
  ensureWorkingVolume,
  pressureOverflowCells,
  sanitizeBounds,
} from '../scene/workingVolume.js';
import {
  applyLinksAfterMove,
  ensureLinks,
  findComponent,
  linkFeatures,
  linkLengthCells,
  linksOf,
  pruneLinks,
  setLinkOffset,
} from '../scene/links.js';
import { analyzeScene } from '../scene/applyCustomBCs.js';
import {
  defaultPointDirs,
  dirVector,
  pointLoadAxes,
  pointLoadDirs,
  pointLoadMode,
  pointSpreadCells,
} from '../scene/pointLoad.js';

const $ = (id) => document.getElementById(id);

const MAX_UNDO = 40;
/** Default spread (fraction of the longest side) of a multi-axis point load. */
const BURST_SPREAD = 0.1;
const MAX_ANALYZE_NODES = 400_000;

const INPUT_CLS =
  'rounded border border-slate-700 bg-slate-950 px-1 py-0.5 font-mono text-[11px] text-slate-200';

function cloneScene(scene) {
  return JSON.parse(JSON.stringify(scene ?? createEmptyScene()));
}

/** Short human description of a bolt hole's constraint + load. */
function holeSummary(f) {
  const fixed = [f.fixX !== false && 'X', f.fixY !== false && 'Y', f.fixZ !== false && 'Z'].filter(Boolean);
  const fix = fixed.length === 3 ? 'clamped' : fixed.length === 0 ? 'free' : `fix ${fixed.join('')}`;
  const load =
    f.loadMode === 'directional'
      ? 'load'
      : f.loadMode === 'multi'
        ? `${(f.loads ?? []).length} loads`
        : f.loadMode === 'circular'
          ? f.circMode === 'radial'
            ? 'radial'
            : 'torque'
          : '';
  return load ? `${fix} · ${load}` : fix;
}

/**
 * Custom scene sidebar editor.
 * @param {{
 *   config: object,
 *   onApply: () => void,
 *   onChange?: () => void,
 *   onTabChange?: (name: 'optimize'|'scene') => void,
 *   onSelect?: (sel: { id: string } | null) => void,
 *   onClear?: () => void,
 *   onLoadRecipe?: (recipeId: string) => void,
 *   onFitDomain?: () => void,
 * }} deps
 */
export function bindSceneEditor({ config, onApply, onChange, onTabChange, onSelect, onClear, onLoadRecipe, onFitDomain }) {
  const ac = new AbortController();
  const { signal } = ac;
  const on = (el, type, fn) => el?.addEventListener(type, fn, { signal });

  const dims = () => ({ nx: config.nx, ny: config.ny, nz: config.nz });

  /** @type {{ id: string } | null} */
  let selected = null;
  /** @type {{ scene: import('../scene/types.js').Scene, recipeId: string | null }[]} */
  const undoStack = [];
  /** @type {'optimize'|'scene'|'stage'} */
  let activeTab = 'optimize';

  function ensureScene() {
    config.scene = normalizeScene(config.scene ?? createEmptyScene());
    ensureWorkingVolume(config.scene, dims());
    return config.scene;
  }
  ensureScene();

  function pushUndo() {
    undoStack.push({ scene: cloneScene(ensureScene()), recipeId: config.recipeId ?? null });
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    config.recipeId = null;
  }

  function highlightRecipe() {
    const root = $('scene-examples');
    if (!root) return;
    root.querySelectorAll('[data-recipe]').forEach((btn) => {
      const on = btn.dataset.recipe === config.recipeId;
      btn.classList.toggle('is-active', on);
    });
  }

  function undo() {
    if (!undoStack.length) return;
    const prev = undoStack.pop();
    config.scene = prev.scene;
    config.recipeId = prev.recipeId;
    ensureScene();
    selected = null;
    onSelect?.(null);
    notify(false);
  }

  function notify(push = false) {
    if (push) pushUndo();
    const scene = ensureScene();
    pruneLinks(scene);
    if (scene.workingVolume?.mode === 'auto') {
      scene.workingVolume.bounds = computeAutoWorkingBounds(scene, scene.workingVolume.padding ?? 0.06, dims());
    }
    onChange?.();
    renderObjectList();
    renderInspector();
    renderWorkingVolumeUI();
    renderWarnings();
    highlightRecipe();
  }

  /* ------------------------------ Warnings ------------------------------ */
  function renderWarnings() {
    const el = $('scene-warnings');
    if (!el) return;
    const scene = ensureScene();
    const nodes = (config.nx + 1) * (config.ny + 1) * (config.nz + 1);
    let warnings = [];
    if (!isSceneEmpty(scene) && nodes <= MAX_ANALYZE_NODES) {
      try {
        warnings = analyzeScene(scene, dims()).warnings;
      } catch (err) {
        console.warn('[scene] analysis failed', err);
      }
    }
    if (!warnings.length) {
      el.classList.add('hidden');
      el.innerHTML = '';
      return;
    }
    el.classList.remove('hidden');
    el.innerHTML = warnings.map((w) => `<div>⚠ ${w}</div>`).join('');
  }

  /* ------------------------------ Object list ------------------------------ */
  function featureName(f) {
    const base = componentDef(f.type)?.label ?? f.type;
    return `${base} @ ${f.x.toFixed(2)},${f.y.toFixed(2)},${f.z.toFixed(2)}`;
  }

  function badgeFor(f) {
    const roles = componentDef(f.type)?.roles(f) ?? { support: false, load: false };
    if (roles.support && roles.load) return 'fix+load';
    if (roles.load) return 'load';
    return 'fix';
  }

  function rowFor(scene, f) {
    let label = componentDef(f.type)?.label ?? f.type;
    let meta = '';
    if (f.type === 'bolt_hole') {
      label = `Bolt ⌀${(f.radius * Math.max(config.nx, config.ny, config.nz) * 2).toFixed(1)} ${f.axis.toUpperCase()}`;
      meta = holeSummary(f);
    } else if (f.type === 'wall_pad') {
      meta = f.face;
    } else if (f.type === 'rest_point') {
      meta = `${f.x.toFixed(2)}, ${f.y.toFixed(2)}`;
    } else if (f.type === 'rest_line') {
      meta = `${String(f.axis || 'z').toUpperCase()} line`;
    } else if (f.type === 'line_load' || f.type === 'face_load') {
      meta = `|F|=${Number(f.magnitude).toFixed(2)}`;
    } else {
      const extra =
        f.type === 'pressure'
          ? ` · ${f.pressureMode === 'directional' ? 'dir' : 'radial'}`
          : f.type === 'point_load' && pointLoadAxes(f) > 1
            ? ` · ${pointLoadAxes(f)} axes`
            : '';
      meta = `|F|=${Number(f.magnitude).toFixed(2)}${extra}`;
    }
    const linked = linksOf(scene, f.id).length ? ' 🔗' : '';
    return { id: f.id, label: label + linked, meta, badge: badgeFor(f) };
  }

  function allObjects() {
    const scene = ensureScene();
    const rows = [];
    for (const fam of FAMILIES) {
      const members = (scene.components ?? []).filter((c) => componentDef(c.type)?.family === fam.id);
      if (!members.length) continue;
      rows.push({ header: fam.label });
      for (const f of members) rows.push(rowFor(scene, f));
    }
    return rows;
  }

  function renderObjectList() {
    const ul = $('list-scene-objects');
    if (!ul) return;
    const rows = allObjects();
    if (!rows.some((r) => r.id)) {
      ul.innerHTML = `<li class="text-[11px] text-slate-500 px-1 py-1">No objects — add a support or load</li>`;
      return;
    }
    ul.innerHTML = rows
      .map((r) => {
        if (r.header) {
          return `<li class="px-1 pt-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">${r.header}</li>`;
        }
        const active = selected?.id === r.id ? 'is-active' : '';
        const badgeCls =
          r.badge === 'fix'
            ? 'bg-emerald-500/15 text-emerald-300'
            : r.badge === 'load'
              ? 'bg-rose-500/15 text-rose-300'
              : 'bg-amber-500/15 text-amber-300';
        return `<li class="scene-item ${active}" data-id="${r.id}" tabindex="0">
          <span class="flex min-w-0 items-center gap-1.5">
            <span class="shrink-0 rounded px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${badgeCls}">${r.badge}</span>
            <span class="truncate">${r.label}</span>
          </span>
          <span class="shrink-0 font-mono text-[10px] text-slate-500">${r.meta}</span>
        </li>`;
      })
      .join('');
  }

  function findSelected() {
    const scene = ensureScene();
    if (!selected) return null;
    return scene.components.find((f) => f.id === selected.id) ?? null;
  }

  /* ------------------------------ Inspector ------------------------------ */
  function field(label, key, value, step = 0.05, min = 0, max = 1, extra = '') {
    return `<label class="flex flex-col gap-0.5 text-slate-400">${label}
      <input data-key="${key}" ${extra} type="number" step="${step}" min="${min}" max="${max}" value="${Number(value)}" class="${INPUT_CLS}" />
    </label>`;
  }

  function selectField(label, key, value, options, span = 2) {
    const opts = options
      .map(([v, t]) => `<option value="${v}" ${v === value ? 'selected' : ''}>${t}</option>`)
      .join('');
    return `<label class="flex flex-col gap-0.5 text-slate-400 col-span-${span}">${label}
      <select data-key="${key}" class="rounded border border-slate-700 bg-slate-950 px-1 py-0.5 text-[11px] text-slate-200">${opts}</select>
    </label>`;
  }

  function checkField(label, key, value) {
    return `<label class="flex items-center gap-1.5 text-slate-400 col-span-1">
      <input data-key="${key}" type="checkbox" ${value ? 'checked' : ''} class="rounded border-slate-600" />
      ${label}
    </label>`;
  }

  const sectionTitle = (t) =>
    `<div class="col-span-2 mt-1 border-t border-slate-700 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300/90">${t}</div>`;

  const DIR_BUTTONS = [
    ['+X', 1, 0, 0],
    ['−X', -1, 0, 0],
    ['+Y', 0, 1, 0],
    ['−Y', 0, -1, 0],
    ['+Z', 0, 0, 1],
    ['−Z', 0, 0, -1],
  ];

  function dirButtons(target) {
    return `<div class="col-span-2 flex flex-wrap gap-1">${DIR_BUTTONS.map(
      ([t, x, y, z]) =>
        `<button type="button" data-dir-target="${target}" data-dir="${x},${y},${z}" class="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300 hover:bg-slate-800">${t}</button>`,
    ).join('')}</div>`;
  }

  function holeInspector(item) {
    let html = '';
    html += field('Radius', 'radius', item.radius, 0.01, 0.02, 0.5);
    html += selectField('Axis', 'axis', item.axis, [['x', 'X'], ['y', 'Y'], ['z', 'Z']], 1);
    const nAxis = { x: config?.nx, y: config?.ny, z: config?.nz }[item.axis] ?? 0;
    const lenCells = nAxis ? ` ≈ ${Math.max(1, Math.round((item.len ?? 0.25) * nAxis))} cells` : '';
    html += field(`Length${lenCells}`, 'len', item.len ?? 0.25, 0.01, 0.01, 1);
    html += `<div class="col-span-2 -mt-0.5 text-[10px] leading-snug text-slate-500">Bore length as a fraction of the domain along its axis, centred on the hole's ${String(item.axis).toUpperCase()} position. The auto working volume fits the bore's real extent.</div>`;
    html += sectionTitle('Constraint (translations clamped)');
    html += checkField('Fix X', 'fixX', item.fixX !== false);
    html += checkField('Fix Y', 'fixY', item.fixY !== false);
    html += checkField('Fix Z', 'fixZ', item.fixZ !== false);
    html += sectionTitle('Load on bore');
    html += selectField('Mode', 'loadMode', item.loadMode ?? 'none', [
      ['none', 'None'],
      ['directional', 'One direction'],
      ['multi', 'Multiple vectors'],
      ['circular', 'Circular (torque / radial)'],
    ]);
    if (item.loadMode === 'directional') {
      html += field('Fx', 'fx', item.fx, 0.1, -1, 1);
      html += field('Fy', 'fy', item.fy, 0.1, -1, 1);
      html += field('Fz', 'fz', item.fz, 0.1, -1, 1);
      html += field('|F|', 'magnitude', item.magnitude, 0.1, -50, 50);
      html += dirButtons('main');
    } else if (item.loadMode === 'multi') {
      (item.loads ?? []).forEach((l, i) => {
        html += `<div class="col-span-2 grid grid-cols-4 items-end gap-1 rounded border border-slate-800 p-1">
          ${['fx', 'fy', 'fz', 'magnitude']
            .map(
              (k) => `<label class="flex flex-col gap-0.5 text-[10px] text-slate-400">${k === 'magnitude' ? '|F|' : k.toUpperCase()}
            <input data-load-idx="${i}" data-load-key="${k}" type="number" step="0.1" value="${Number(l[k])}" class="${INPUT_CLS} w-full" /></label>`,
            )
            .join('')}
          <div class="col-span-4 flex items-center justify-between">
            <span class="flex gap-1">${DIR_BUTTONS.map(
              ([t, x, y, z]) =>
                `<button type="button" data-dir-target="${i}" data-dir="${x},${y},${z}" class="rounded border border-slate-700 px-1 py-0 text-[9px] text-slate-300 hover:bg-slate-800">${t}</button>`,
            ).join('')}</span>
            <button type="button" data-load-remove="${i}" class="text-[10px] text-rose-300 hover:text-rose-200">Remove</button>
          </div>
        </div>`;
      });
      html += `<button type="button" data-load-add="1" class="col-span-2 rounded border border-slate-700 px-2 py-1 text-[10px] text-slate-300 hover:bg-slate-800">+ Add vector</button>`;
    } else if (item.loadMode === 'circular') {
      html += selectField('Type', 'circMode', item.circMode ?? 'torque', [
        ['torque', 'Torque (tangential about axis)'],
        ['radial', 'Radial (press-fit, + outward)'],
      ]);
      html += field('Signed |F|', 'magnitude', item.magnitude, 0.1, -50, 50);
      html += `<p class="col-span-2 text-[10px] text-slate-500">Self-balanced ring load on the whole bore. Negative reverses (CW / inward).</p>`;
    }
    html += `<p class="col-span-2 text-[10px] leading-snug text-slate-500">Axes the load acts along must be <b>unchecked</b> above or the support absorbs them.</p>`;
    return html;
  }

  const AXES_OPTIONS = [
    ['1', '1 axis — single force'],
    ['2', '2 axes'],
    ['3', '3 axes'],
    ['4', '4 axes'],
    ['5', '5 axes'],
    ['6', '6 axes — all directions'],
  ];

  function pointLoadInspector(item) {
    const n = pointLoadAxes(item);
    let html = selectField('Force axes', 'axes', String(n), AXES_OPTIONS);
    if (n === 1) {
      html += field('Fx', 'fx', item.fx, 0.1, -1, 1);
      html += field('Fy', 'fy', item.fy, 0.1, -1, 1);
      html += field('Fz', 'fz', item.fz, 0.1, -1, 1);
      html += field('|F|', 'magnitude', item.magnitude, 0.1, -50, 50);
      html += dirButtons('main');
      return html;
    }
    const chosen = new Set(pointLoadDirs(item));
    const maxDim = Math.max(config?.nx ?? 0, config?.ny ?? 0, config?.nz ?? 0) || 32;
    const burst = pointLoadMode(item) === 'burst';
    html += selectField('Axes act', 'axesMode', burst ? 'burst' : 'cases', [
      ['cases', 'Separately — load cases'],
      ['burst', 'Together — burst'],
    ]);
    html += field('|F| per axis', 'magnitude', item.magnitude, 0.1, -50, 50);
    if (burst) {
      html += field(`Spread ≈ ${pointSpreadCells(item, maxDim)} cells`, 'radius', item.radius ?? 0.04, 0.01, 0.01, 0.3);
    }
    html += `<div class="col-span-2 flex flex-wrap gap-1">${DIR_BUTTONS.map(([t, x, y, z]) => {
      const code = (x ? 'x' : y ? 'y' : 'z') + (x + y + z < 0 ? '-' : '+');
      const active = chosen.has(code);
      return `<button type="button" data-point-dir="${code}" aria-pressed="${active}" class="rounded border px-1.5 py-0.5 text-[10px] ${
        active ? 'border-indigo-400 bg-indigo-500/25 text-indigo-100' : 'border-slate-700 text-slate-400 hover:bg-slate-800'
      }">${t}</button>`;
    }).join('')}</div>`;
    html += `<p class="col-span-2 text-[10px] leading-snug text-slate-500">${
      burst
        ? `All ${n} directions push at once, each on the node <i>Spread</i> cells away. Self-balanced: it needs no support, so the optimizer builds a body around the point. Negative |F| pulls inward.`
        : `The load acts along each of the ${n} directions <b>one at a time</b> (${n} load cases solved per iteration, compliances summed), so the structure must carry every direction and the supports react each one. Opposing directions never cancel.`
    }</p>`;
    return html;
  }

  /** Change the number of force axes of a point load (directions reset to the natural sets). */
  function setPointAxes(item, n) {
    item.axes = Math.max(1, Math.min(6, Math.round(n) || 1));
    item.dirs = item.axes > 1 ? defaultPointDirs(item, item.axes) : [];
    // A burst needs room between its arrows: widen the default single-point radius.
    if (item.axes > 1 && pointLoadMode(item) === 'burst' && !(item.radius > 0.05)) item.radius = BURST_SPREAD;
  }

  function pressureInspector(item) {
    let html = '';
    html += selectField('Shape', 'shape', item.shape, [['sphere', 'Sphere cavity'], ['box', 'Box cavity']], 1);
    html += selectField('Mode', 'pressureMode', item.pressureMode, [['radial', 'Radial'], ['directional', 'Directional']], 1);
    if (item.shape === 'box') {
      html += field('Half X', 'hx', item.hx, 0.01, 0.02, 0.5);
      html += field('Half Y', 'hy', item.hy, 0.01, 0.02, 0.5);
      html += field('Half Z', 'hz', item.hz, 0.01, 0.02, 0.5);
    } else {
      html += field('Radius', 'radius', item.radius, 0.01, 0.02, 0.5);
    }
    html += field('|P|', 'magnitude', item.magnitude, 0.1, -50, 50);
    if (item.pressureMode === 'directional') {
      html += field('Dir X', 'fx', item.fx, 0.1, -1, 1);
      html += field('Dir Y', 'fy', item.fy, 0.1, -1, 1);
      html += field('Dir Z', 'fz', item.fz, 0.1, -1, 1);
      html += dirButtons('main');
    } else {
      html += checkField('Inward', 'inward', item.inward);
    }
    html += checkField('Void cavity', 'cavityVoid', item.cavityVoid !== false);
    html += field('Wall (cells)', 'wall', item.wall ?? 2, 1, 1, 6);
    html += `<p class="col-span-2 text-[10px] leading-snug text-slate-500">Void cavity carves the interior and locks a solid wall so the pressure always has material to act on. Radial pressure is self-balanced — add a directional one (net thrust) so supports carry load.</p>`;
    return html;
  }

  function linkSection(item) {
    const scene = ensureScene();
    const links = linksOf(scene, item.id);
    const d = dims();
    let html = `<div class="col-span-2 mt-1 border-t border-slate-700 pt-1.5">
      <div class="mb-1 text-[10px] font-semibold uppercase tracking-wide text-amber-300/90">Rigid links</div>`;
    const linkedIds = new Set([item.id]);
    for (const l of links) {
      const otherId = l.aId === item.id ? l.bId : l.aId;
      linkedIds.add(otherId);
      const other = findComponent(scene, otherId);
      const sgn = l.aId === item.id ? 1 : -1; // show offset of partner relative to THIS item
      const cell = (key, n) => (sgn * l[key] * n).toFixed(1);
      html += `<div class="mb-1 rounded border border-slate-800 p-1.5">
        <div class="mb-1 flex items-center justify-between text-[10px] text-slate-400">
          <span class="truncate">→ ${other ? featureName(other) : otherId} · <span class="font-mono text-slate-300">${linkLengthCells(l, d).toFixed(1)} cells</span></span>
          <button type="button" data-link-unlink="${l.id}" class="shrink-0 text-rose-300 hover:text-rose-200">Unlink</button>
        </div>
        <div class="grid grid-cols-3 gap-1">
          ${[['dx', 'ΔX', d.nx], ['dy', 'ΔY', d.ny], ['dz', 'ΔZ', d.nz]]
            .map(
              ([k, t, n]) => `<label class="flex flex-col gap-0.5 text-[10px] text-slate-400">${t} (cells)
            <input data-link-id="${l.id}" data-link-key="${k}" data-link-sign="${sgn}" data-link-n="${n}" type="number" step="1" value="${cell(k, n)}" class="${INPUT_CLS} w-full" /></label>`,
            )
            .join('')}
        </div>
      </div>`;
    }
    const candidates = (scene.components ?? []).filter((f) => !linkedIds.has(f.id));
    if (candidates.length) {
      html += `<label class="flex flex-col gap-0.5 text-slate-400">Link to…
        <select data-link-partner="1" class="rounded border border-slate-700 bg-slate-950 px-1 py-0.5 text-[11px] text-slate-200">
          <option value="">— choose —</option>
          ${candidates.map((f) => `<option value="${f.id}">${featureName(f)}</option>`).join('')}
        </select></label>`;
    }
    html += `<p class="mt-1 text-[10px] leading-snug text-slate-500">${
      links.length
        ? 'Drag either end — linked features move together at the offsets above (edit to re-space).'
        : 'Linking keeps the current separation fixed (yellow line); drag one and the other follows.'
    }</p></div>`;
    return html;
  }

  function renderInspector() {
    const panel = $('scene-inspector');
    const fields = $('inspector-fields');
    const title = $('inspector-title');
    const item = findSelected();
    if (!panel || !fields) return;
    if (!item) {
      panel.classList.add('hidden');
      return;
    }
    panel.classList.remove('hidden');
    if (title) title.textContent = componentDef(item.type)?.label ?? item.type;

    // Keep focus/scroll stable while re-rendering after an edit.
    const activeKey = document.activeElement?.dataset?.key;

    let html = '';
    html += field('X', 'x', item.x);
    html += field('Y', 'y', item.y);
    html += field('Z', 'z', item.z);
    if (item.type === 'bolt_hole') {
      html += holeInspector(item);
    } else if (item.type === 'wall_pad') {
      html += selectField('Face', 'face', item.face, [
        ['x-', 'X−'], ['x+', 'X+'], ['y-', 'Y−'], ['y+', 'Y+'], ['z-', 'Z−'], ['z+', 'Z+'],
      ]);
      html += field('Width', 'width', item.width, 0.05, 0.05, 1);
      html += field('Height', 'height', item.height, 0.05, 0.05, 1);
      html += field('Depth (cells)', 'depth', item.depth, 1, 1, 8);
      html += checkField('Solid', 'solid', item.solid !== false);
    } else if (item.type === 'rest_point') {
      html += field('Radius', 'radius', item.radius, 0.01, 0.02, 0.5);
      html += checkField('Fix X', 'fixX', item.fixX !== false);
      html += checkField('Fix Y', 'fixY', item.fixY !== false);
      html += checkField('Fix Z', 'fixZ', item.fixZ !== false);
      html += checkField('Solid', 'solid', item.solid !== false);
    } else if (item.type === 'rest_line') {
      html += selectField('Axis', 'axis', item.axis, [['x', 'X'], ['y', 'Y'], ['z', 'Z']]);
      html += field('Length', 'len', item.len, 0.05, 0.05, 1);
      html += checkField('Fix X', 'fixX', item.fixX !== false);
      html += checkField('Fix Y', 'fixY', item.fixY !== false);
      html += checkField('Fix Z', 'fixZ', item.fixZ !== false);
      html += checkField('Solid', 'solid', item.solid !== false);
    } else if (item.type === 'line_load' || item.type === 'face_load') {
      if (item.type === 'line_load') {
        html += selectField('Axis', 'axis', item.axis, [['x', 'X'], ['y', 'Y'], ['z', 'Z']]);
        html += field('Length', 'len', item.len, 0.05, 0.05, 1);
      } else {
        html += selectField('Face', 'face', item.face, [
          ['x-', 'X−'], ['x+', 'X+'], ['y-', 'Y−'], ['y+', 'Y+'], ['z-', 'Z−'], ['z+', 'Z+'],
        ]);
        html += field('Width', 'width', item.width, 0.05, 0.05, 1);
        html += field('Height', 'height', item.height, 0.05, 0.05, 1);
        html += field('Width inset (cells)', 'inset', item.inset ?? 0, 1, 0, 64);
      }
      html += field('Fx', 'fx', item.fx, 0.1, -1, 1);
      html += field('Fy', 'fy', item.fy, 0.1, -1, 1);
      html += field('Fz', 'fz', item.fz, 0.1, -1, 1);
      html += field('Magnitude', 'magnitude', item.magnitude, 0.1, -5, 5);
    } else if (item.type === 'pressure') {
      html += pressureInspector(item);
    } else {
      html += pointLoadInspector(item);
    }
    html += linkSection(item);

    fields.innerHTML = html;
    if (activeKey && document.activeElement === document.body) {
      fields.querySelector(`[data-key="${activeKey}"]`)?.focus?.();
    }
  }

  function selectItem(id, { fromGizmo = false } = {}) {
    selected = id ? { id } : null;
    if (!fromGizmo) onSelect?.(selected);
    renderObjectList();
    renderInspector();
  }

  function deleteSelected() {
    if (!selected) return;
    pushUndo();
    const scene = ensureScene();
    const id = selected.id;
    scene.components = scene.components.filter((f) => f.id !== id);
    pruneLinks(scene, id);
    selected = null;
    onSelect?.(null);
    notify(false);
  }

  /* ------------------------------ Add tools ------------------------------ */
  function select(id) {
    selected = { id };
    onSelect?.(selected);
    notify(false);
  }

  function addFixation(type, partial = {}) {
    pushUndo();
    const scene = ensureScene();
    const base = type === 'bolt_hole' ? { y: 0.5, z: 0.5, x: 0.5, radius: 0.045 } : {};
    const f = createComponent(type, { ...base, ...partial });
    scene.components.push(f);
    select(f.id);
  }

  function addLoadedHole() {
    pushUndo();
    const scene = ensureScene();
    const f = createLoadedHole({ x: 0.7, y: 0.5, z: 0.5, radius: 0.045, loadMode: 'directional', fy: -1 });
    scene.components.push(f);
    select(f.id);
  }

  function addForce(type, partial = {}) {
    pushUndo();
    const scene = ensureScene();
    const f = createComponent(type, partial);
    scene.components.push(f);
    select(f.id);
  }

  /** Point load with `n` force axes (n > 1 starts inside the volume so every side can push). */
  function addPointLoad(n = 1) {
    const axes = Math.max(1, Math.min(6, Math.round(n) || 1));
    addForce('point_load', axes > 1 ? { axes, dirs: defaultPointDirs({ fy: -1 }, axes) } : {});
  }

  const pointMenu = $('point-menu');
  const pointMenuBtn = $('btn-add-point-menu');
  function setPointMenu(open) {
    pointMenu?.classList.toggle('hidden', !open);
    pointMenuBtn?.setAttribute('aria-expanded', String(open));
  }
  on(pointMenuBtn, 'click', (e) => {
    e.stopPropagation();
    setPointMenu(pointMenu?.classList.contains('hidden') ?? false);
  });
  on(pointMenu, 'click', (e) => {
    const b = e.target.closest('[data-point-axes]');
    if (!b) return;
    setPointMenu(false);
    addPointLoad(Number(b.dataset.pointAxes));
  });
  on(document, 'click', (e) => {
    if (!pointMenu || pointMenu.classList.contains('hidden')) return;
    if (!e.target.closest?.('#point-menu-wrap')) setPointMenu(false);
  });
  on(window, 'keydown', (e) => {
    if (e.key === 'Escape') setPointMenu(false);
  });

  /** Bracket starter: clamped hole + loaded hole, rigidly linked at the current spacing. */
  function addBoltPair() {
    pushUndo();
    const scene = ensureScene();
    const r = 0.05;
    const left = createComponent('bolt_hole', { x: 0.2, y: 0.5, z: 0.5, axis: 'z', radius: r });
    const right = createLoadedHole({
      x: 0.8,
      y: 0.5,
      z: 0.5,
      axis: 'z',
      radius: r,
      loadMode: 'directional',
      fx: 0,
      fy: -1,
      fz: 0,
      magnitude: 1,
    });
    scene.components.push(left, right);
    linkFeatures(scene, left.id, right.id, dims());
    select(right.id);
  }

  /* ------------------------------ Object list events ------------------------------ */
  on($('list-scene-objects'), 'click', (e) => {
    const li = e.target.closest('[data-id]');
    if (li) selectItem(li.dataset.id);
  });
  on($('list-scene-objects'), 'keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const li = e.target.closest?.('[data-id]');
    if (!li) return;
    e.preventDefault();
    selectItem(li.dataset.id);
  });

  on($('btn-add-rest'), 'click', () => addFixation('rest_point'));
  on($('btn-add-bolt-hole'), 'click', () => addFixation('bolt_hole'));
  on($('btn-add-bolt-loaded'), 'click', () => addLoadedHole());
  on($('btn-add-wall-pad'), 'click', () => addFixation('wall_pad'));
  on($('btn-add-point-load'), 'click', () => addPointLoad(1));
  on($('btn-add-pressure'), 'click', () => addForce('pressure'));
  on($('btn-add-bolt-pair'), 'click', () => addBoltPair());

  /* ------------------------------ Examples ------------------------------ */
  const examplesEl = $('scene-examples');
  if (examplesEl) {
    const examples = listRecipes().filter((r) => r.meta?.group === 'example');
    examplesEl.innerHTML = examples
      .map(
        (ex) => `<button type="button" class="btn-secondary !py-1.5 text-[10px]" data-recipe="${ex.id}" title="${ex.meta?.blurb ?? ''}">
        <i class="ph ${ex.meta?.icon ?? 'ph-cube'}"></i> ${ex.name}
      </button>`,
      )
      .join('');
    on(examplesEl, 'click', (e) => {
      const btn = e.target.closest('[data-recipe]');
      if (!btn?.dataset.recipe) return;
      onLoadRecipe?.(btn.dataset.recipe);
    });
  }

  function loadScene(scene) {
    pushUndo();
    config.scene = normalizeScene(cloneScene(scene));
    ensureWorkingVolume(config.scene, dims());
    selected = null;
    onSelect?.(null);
    notify(false);
  }

  function clearScene() {
    pushUndo();
    // Replace the whole scene object so every consumer drops old references.
    config.scene = createEmptyScene();
    ensureWorkingVolume(config.scene, dims());
    selected = null;
    onSelect?.(null);
    renderObjectList();
    renderInspector();
    renderWorkingVolumeUI();
    renderWarnings();
    onChange?.();
    onClear?.();
  }

  on($('btn-scene-clear'), 'click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    clearScene();
  });

  on($('btn-scene-apply'), 'click', () => {
    const scene = ensureScene();
    if (isSceneEmpty(scene)) {
      console.warn('[scene] Add at least one support and load before applying');
      return;
    }
    config.preset = 'custom';
    onApply();
  });

  on($('btn-inspector-delete'), 'click', () => deleteSelected());
  on($('btn-scene-undo'), 'click', () => undo());

  /* ------------------------------ Working volume ------------------------------ */
  function renderWorkingVolumeUI() {
    const scene = ensureScene();
    const wv = ensureWorkingVolume(scene, dims());
    for (const mode of ['full', 'auto', 'manual']) {
      const btn = $(`wv-mode-${mode}`);
      btn?.classList.toggle('is-active', wv.mode === mode);
      btn?.setAttribute('aria-pressed', String(wv.mode === mode));
    }
    const hint = $('wv-hint');
    if (hint) {
      hint.textContent =
        wv.mode === 'full'
          ? 'Entire FEA domain is designable.'
          : wv.mode === 'auto'
            ? 'Box fitted to holes (boss + span), pressure cavity + wall, pads, rests and loads (+ pad).'
            : 'Manual box (0–1 of the domain). Outside = void.';
      hint.textContent += ' Drag the corner handles in the viewport: on release the box is meshed with cubic voxels (cell count from Voxel Domain).';
    }
    const b = wv.bounds;
    const set = (id, v) => {
      const el = $(id);
      if (el && document.activeElement !== el) el.value = Number(v).toFixed(2);
    };
    set('wv-x0', b.x0);
    set('wv-x1', b.x1);
    set('wv-y0', b.y0);
    set('wv-y1', b.y1);
    set('wv-z0', b.z0);
    set('wv-z1', b.z1);
    const pad = $('wv-padding');
    if (pad && document.activeElement !== pad) pad.value = String(wv.padding ?? 0.06);
    // Fields stay editable in every mode: typing in Auto / Full switches to Manual, starting from
    // the current box.
    const size = $('wv-size');
    if (size) {
      const cx = (b.x1 - b.x0) * config.nx;
      const cy = (b.y1 - b.y0) * config.ny;
      const cz = (b.z1 - b.z0) * config.nz;
      size.textContent = `${cx.toFixed(1)} × ${cy.toFixed(1)} × ${cz.toFixed(1)} cells of ${config.nx} × ${config.ny} × ${config.nz}`;
      // A cavity + wall bigger than the domain gets clipped by the domain edge: say so.
      const over = pressureOverflowCells(config.scene, { nx: config.nx, ny: config.ny, nz: config.nz });
      size.classList.toggle('text-amber-400', !!over);
      size.classList.toggle('text-slate-500', !over);
      if (over) {
        const worst = Math.max(...Object.values(over));
        size.textContent += `\n⚠ Pressure cavity + wall pokes out of the domain by up to ${worst.toFixed(1)} cells: press "Fit domain" to enlarge it.`;
      }
    }
  }

  function setWorkingMode(mode) {
    pushUndo();
    const scene = ensureScene();
    const wv = ensureWorkingVolume(scene, dims());
    wv.mode = mode;
    if (mode === 'auto') wv.bounds = computeAutoWorkingBounds(scene, wv.padding ?? 0.06, dims());
    else if (mode === 'full') wv.bounds = { x0: 0, x1: 1, y0: 0, y1: 1, z0: 0, z1: 1 };
    else wv.bounds = sanitizeBounds(wv.bounds);
    notify(false);
  }

  on($('wv-mode-full'), 'click', () => setWorkingMode('full'));
  on($('wv-mode-auto'), 'click', () => setWorkingMode('auto'));
  on($('wv-mode-manual'), 'click', () => setWorkingMode('manual'));

  on($('btn-wv-fit'), 'click', () => onFitDomain?.());

  on($('btn-wv-refit'), 'click', () => {
    pushUndo();
    const scene = ensureScene();
    const wv = ensureWorkingVolume(scene, dims());
    wv.mode = 'auto';
    wv.bounds = computeAutoWorkingBounds(scene, wv.padding ?? 0.06, dims());
    notify(false);
  });

  on($('wv-padding'), 'change', (e) => {
    pushUndo();
    const scene = ensureScene();
    const wv = ensureWorkingVolume(scene, dims());
    const v = parseFloat(e.target.value);
    wv.padding = Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0.06));
    if (wv.mode === 'auto') wv.bounds = computeAutoWorkingBounds(scene, wv.padding, dims());
    notify(false);
  });

  for (const key of ['x0', 'x1', 'y0', 'y1', 'z0', 'z1']) {
    on($(`wv-${key}`), 'change', (e) => {
      pushUndo();
      const scene = ensureScene();
      const wv = ensureWorkingVolume(scene, dims());
      wv.mode = 'manual';
      wv.bounds = sanitizeBounds({ ...wv.bounds, [key]: parseFloat(e.target.value) });
      notify(false);
    });
  }

  /* ------------------------------ Inspector events ------------------------------ */
  const inspectorEl = $('inspector-fields');

  on(inspectorEl, 'click', (e) => {
    const scene = ensureScene();
    const item = findSelected();
    if (!item) return;

    const unlink = e.target.closest('[data-link-unlink]');
    if (unlink) {
      pushUndo();
      scene.links = ensureLinks(scene).filter((l) => l.id !== unlink.dataset.linkUnlink);
      notify(false);
      return;
    }

    // Point load (multi-axis): toggle one direction. Fewer than 2 left → back to a single force.
    const pointDir = e.target.closest('[data-point-dir]');
    if (pointDir && item.type === 'point_load') {
      const code = pointDir.dataset.pointDir;
      const cur = pointLoadDirs(item);
      const next = cur.includes(code) ? cur.filter((d) => d !== code) : [...cur, code];
      if (!next.length) return; // keep at least one direction
      pushUndo();
      if (next.length === 1) {
        const v = dirVector(next[0]);
        item.fx = v[0];
        item.fy = v[1];
        item.fz = v[2];
        item.axes = 1;
        item.dirs = [];
      } else {
        item.axes = next.length;
        item.dirs = next;
      }
      notify(false);
      return;
    }

    const dirBtn = e.target.closest('[data-dir]');
    if (dirBtn) {
      const [x, y, z] = dirBtn.dataset.dir.split(',').map(Number);
      pushUndo();
      const target = dirBtn.dataset.dirTarget;
      const tgt = target === 'main' ? item : item.loads?.[Number(target)];
      if (tgt) {
        tgt.fx = x;
        tgt.fy = y;
        tgt.fz = z;
      }
      notify(false);
      return;
    }

    if (e.target.closest('[data-load-add]')) {
      pushUndo();
      item.loads = [...(item.loads ?? []), { fx: 0, fy: -1, fz: 0, magnitude: 1 }];
      notify(false);
      return;
    }
    const rem = e.target.closest('[data-load-remove]');
    if (rem) {
      pushUndo();
      item.loads = (item.loads ?? []).filter((_, i) => i !== Number(rem.dataset.loadRemove));
      notify(false);
    }
  });

  on(inspectorEl, 'change', (e) => {
    const scene = ensureScene();
    const item = findSelected();
    if (!item) return;
    const t = /** @type {HTMLInputElement} */ (e.target);

    // New link
    if (t.matches?.('[data-link-partner]')) {
      if (!t.value) return;
      pushUndo();
      linkFeatures(scene, item.id, t.value, dims());
      notify(false);
      return;
    }

    // Link offset (cells, relative to the selected item)
    if (t.matches?.('[data-link-key]')) {
      const link = ensureLinks(scene).find((l) => l.id === t.dataset.linkId);
      const v = parseFloat(t.value);
      if (!link || !Number.isFinite(v)) return;
      pushUndo();
      const sgn = Number(t.dataset.linkSign) || 1;
      const n = Number(t.dataset.linkN) || 1;
      setLinkOffset(scene, link, { [t.dataset.linkKey]: (sgn * v) / n });
      notify(false);
      return;
    }

    // Multi-vector rows
    if (t.matches?.('[data-load-idx]')) {
      const v = parseFloat(t.value);
      const row = item.loads?.[Number(t.dataset.loadIdx)];
      if (!row || !Number.isFinite(v)) return;
      pushUndo();
      row[t.dataset.loadKey] = v;
      notify(false);
      return;
    }

    const key = t.dataset?.key;
    if (!key) return;
    let val;
    if (t.type === 'checkbox') val = !!t.checked;
    else if (t.type === 'number') {
      val = parseFloat(t.value);
      if (!Number.isFinite(val)) return;
    } else val = t.value;
    pushUndo();
    if (key === 'axes' && item.type === 'point_load') {
      setPointAxes(item, Number(val));
      notify(false);
      return;
    }
    if (key === 'axesMode' && item.type === 'point_load') {
      item.axesMode = val === 'burst' ? 'burst' : 'cases';
      if (item.axesMode === 'burst' && !(item.radius > 0.05)) item.radius = BURST_SPREAD;
      notify(false);
      return;
    }
    item[key] = val;
    // Moving via the inspector must carry linked features too.
    if (key === 'x' || key === 'y' || key === 'z') applyLinksAfterMove(scene, item.id);
    notify(false);
  });

  /* Keyboard: Del delete, Ctrl+Z undo (when scene tab active, not typing numbers) */
  on(window, 'keydown', (e) => {
    if (activeTab !== 'scene') return;
    const tag = (e.target && /** @type {HTMLElement} */ (e.target).tagName) || '';
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

    if ((e.key === 'Delete' || e.key === 'Backspace') && !typing) {
      if (!selected) return;
      e.preventDefault();
      deleteSelected();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z') && !e.shiftKey) {
      e.preventDefault();
      undo();
    }
  });

  /* ------------------------------ Sidebar tabs ------------------------------ */
  function showTab(name) {
    const tab = name === 'scene' || name === 'stage' ? name : 'optimize';
    const isScene = tab === 'scene';
    activeTab = tab;
    for (const n of ['optimize', 'scene', 'stage']) {
      $(`panel-${n}`)?.classList.toggle('hidden', n !== tab);
      const t = $(`tab-${n}`);
      t?.classList.toggle('is-active', n === tab);
      t?.setAttribute('aria-selected', String(n === tab));
    }
    onTabChange?.(tab);
    if (isScene) notify(false);
  }

  on($('tab-optimize'), 'click', () => showTab('optimize'));
  on($('tab-scene'), 'click', () => showTab('scene'));
  on($('tab-stage'), 'click', () => showTab('stage'));

  renderObjectList();
  renderWorkingVolumeUI();
  renderWarnings();

  return {
    showTab,
    loadScene,
    highlightRecipe,
    refresh: () => {
      config.recipeId = null;
      notify(false);
    },
    /** Swap in a re-normalised scene (grid change): old undo snapshots no longer fit. */
    replaceScene: (scene) => {
      config.scene = scene;
      config.recipeId = null;
      undoStack.length = 0;
      selected = null;
      onSelect?.(null);
      notify(false);
    },
    selectItem,
    getSelected: () => selected,
    clearScene,
    dispose: () => ac.abort(),
  };
}
