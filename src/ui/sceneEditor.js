import {
  createEmptyScene,
  createFixation,
  createForce,
  createLoadedHole,
  isSceneEmpty,
  normalizeScene,
} from '../scene/types.js';
import { SCENE_EXAMPLES } from '../scene/templates.js';
import {
  computeAutoWorkingBounds,
  ensureWorkingVolume,
  sanitizeBounds,
} from '../scene/workingVolume.js';
import {
  applyLinksAfterMove,
  ensureLinks,
  findFeatureById,
  linkFeatures,
  linkLengthCells,
  linksOf,
  pruneLinks,
  setLinkOffset,
} from '../scene/links.js';
import { analyzeScene } from '../scene/applyCustomBCs.js';

const $ = (id) => document.getElementById(id);

const FIX_LABELS = {
  rest_point: 'Rest',
  bolt_hole: 'Bolt hole',
  wall_pad: 'Wall pad',
};

const FORCE_LABELS = {
  point_load: 'Point load',
  pressure: 'Pressure',
};

const MAX_UNDO = 40;
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
 *   onSelect?: (sel: { kind: 'fixation'|'force', id: string } | null) => void,
 *   onClear?: () => void,
 *   onResolution?: (key: string) => void,
 * }} deps
 */
export function bindSceneEditor({ config, onApply, onChange, onTabChange, onSelect, onClear, onResolution }) {
  const ac = new AbortController();
  const { signal } = ac;
  const on = (el, type, fn) => el?.addEventListener(type, fn, { signal });

  const dims = () => ({ nx: config.nx, ny: config.ny, nz: config.nz });

  /** @type {{ kind: 'fixation'|'force', id: string } | null} */
  let selected = null;
  /** @type {import('../scene/types.js').Scene[]} */
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
    undoStack.push(cloneScene(ensureScene()));
    if (undoStack.length > MAX_UNDO) undoStack.shift();
  }

  function undo() {
    if (!undoStack.length) return;
    config.scene = undoStack.pop();
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
    const base = FIX_LABELS[f.type] ?? FORCE_LABELS[f.type] ?? f.type;
    return `${base} @ ${f.x.toFixed(2)},${f.y.toFixed(2)},${f.z.toFixed(2)}`;
  }

  function allObjects() {
    const scene = ensureScene();
    const rows = [];
    for (const f of scene.fixations ?? []) {
      let badge = 'fix';
      let meta = '';
      let label = FIX_LABELS[f.type] ?? f.type;
      if (f.type === 'bolt_hole') {
        const loaded = f.loadMode && f.loadMode !== 'none';
        const anyFixed = f.fixX !== false || f.fixY !== false || f.fixZ !== false;
        badge = loaded && anyFixed ? 'fix+load' : loaded ? 'load' : 'fix';
        label = `Bolt ⌀${(f.radius * Math.max(config.nx, config.ny, config.nz) * 2).toFixed(1)} ${f.axis.toUpperCase()}`;
        meta = holeSummary(f);
      } else if (f.type === 'wall_pad') {
        meta = f.face;
      } else {
        meta = `${f.x.toFixed(2)}, ${f.y.toFixed(2)}`;
      }
      const linked = linksOf(scene, f.id).length ? ' 🔗' : '';
      rows.push({ kind: 'fixation', id: f.id, label: label + linked, meta, badge });
    }
    for (const f of scene.forces ?? []) {
      const linked = linksOf(scene, f.id).length ? ' 🔗' : '';
      const extra = f.type === 'pressure' ? ` · ${f.pressureMode === 'directional' ? 'dir' : 'radial'}` : '';
      rows.push({
        kind: 'force',
        id: f.id,
        label: (FORCE_LABELS[f.type] ?? f.type) + linked,
        meta: `|F|=${Number(f.magnitude).toFixed(2)}${extra}`,
        badge: 'load',
      });
    }
    return rows;
  }

  function renderObjectList() {
    const ul = $('list-scene-objects');
    if (!ul) return;
    const rows = allObjects();
    if (!rows.length) {
      ul.innerHTML = `<li class="text-[11px] text-slate-500 px-1 py-1">No objects — add a support or load</li>`;
      return;
    }
    ul.innerHTML = rows
      .map((r) => {
        const active = selected?.id === r.id ? 'is-active' : '';
        const badgeCls =
          r.badge === 'fix'
            ? 'bg-emerald-500/15 text-emerald-300'
            : r.badge === 'load'
              ? 'bg-rose-500/15 text-rose-300'
              : 'bg-amber-500/15 text-amber-300';
        return `<li class="scene-item ${active}" data-kind="${r.kind}" data-id="${r.id}" tabindex="0">
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
    if (selected.kind === 'fixation') return scene.fixations.find((f) => f.id === selected.id) ?? null;
    return scene.forces.find((f) => f.id === selected.id) ?? null;
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
      const other = findFeatureById(scene, otherId)?.feature;
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
    const candidates = [...(scene.fixations ?? []), ...(scene.forces ?? [])].filter((f) => !linkedIds.has(f.id));
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
    const isFix = selected.kind === 'fixation';
    if (title) title.textContent = isFix ? FIX_LABELS[item.type] : FORCE_LABELS[item.type];

    // Keep focus/scroll stable while re-rendering after an edit.
    const activeKey = document.activeElement?.dataset?.key;

    let html = '';
    html += field('X', 'x', item.x);
    html += field('Y', 'y', item.y);
    html += field('Z', 'z', item.z);
    if (isFix) {
      if (item.type === 'bolt_hole') {
        html += holeInspector(item);
      } else if (item.type === 'wall_pad') {
        html += selectField('Face', 'face', item.face, [
          ['x-', 'X−'], ['x+', 'X+'], ['y-', 'Y−'], ['y+', 'Y+'], ['z-', 'Z−'], ['z+', 'Z+'],
        ]);
        html += field('Width', 'width', item.width, 0.05, 0.05, 1);
        html += field('Height', 'height', item.height, 0.05, 0.05, 1);
        html += field('Depth (cells)', 'depth', item.depth, 1, 1, 8);
      } else if (item.type === 'rest_point') {
        html += field('Radius', 'radius', item.radius, 0.01, 0.02, 0.5);
        html += checkField('Fix X', 'fixX', item.fixX !== false);
        html += checkField('Fix Y', 'fixY', item.fixY !== false);
        html += checkField('Fix Z', 'fixZ', item.fixZ !== false);
      }
    } else if (item.type === 'pressure') {
      html += pressureInspector(item);
    } else {
      html += field('Fx', 'fx', item.fx, 0.1, -1, 1);
      html += field('Fy', 'fy', item.fy, 0.1, -1, 1);
      html += field('Fz', 'fz', item.fz, 0.1, -1, 1);
      html += field('|F|', 'magnitude', item.magnitude, 0.1, -50, 50);
      html += dirButtons('main');
    }
    html += linkSection(item);

    fields.innerHTML = html;
    if (activeKey && document.activeElement === document.body) {
      fields.querySelector(`[data-key="${activeKey}"]`)?.focus?.();
    }
  }

  function selectItem(kind, id, { fromGizmo = false } = {}) {
    selected = kind && id ? { kind, id } : null;
    if (!fromGizmo) onSelect?.(selected);
    renderObjectList();
    renderInspector();
  }

  function deleteSelected() {
    if (!selected) return;
    pushUndo();
    const scene = ensureScene();
    const id = selected.id;
    scene.fixations = scene.fixations.filter((f) => f.id !== id);
    scene.forces = scene.forces.filter((f) => f.id !== id);
    pruneLinks(scene, id);
    selected = null;
    onSelect?.(null);
    notify(false);
  }

  /* ------------------------------ Add tools ------------------------------ */
  function select(kind, id) {
    selected = { kind, id };
    onSelect?.(selected);
    notify(false);
  }

  function addFixation(type, partial = {}) {
    pushUndo();
    const scene = ensureScene();
    const base = type === 'bolt_hole' ? { y: 0.5, z: 0.5, x: 0.5, radius: 0.045 } : {};
    const f = createFixation({ type, ...base, ...partial });
    scene.fixations.push(f);
    select('fixation', f.id);
  }

  function addLoadedHole() {
    pushUndo();
    const scene = ensureScene();
    const f = createLoadedHole({ x: 0.7, y: 0.5, z: 0.5, radius: 0.045, loadMode: 'directional', fy: -1 });
    scene.fixations.push(f);
    select('fixation', f.id);
  }

  function addForce(type) {
    pushUndo();
    const scene = ensureScene();
    const f = createForce({ type });
    scene.forces.push(f);
    select('force', f.id);
  }

  /** Bracket starter: clamped hole + loaded hole, rigidly linked at the current spacing. */
  function addBoltPair() {
    pushUndo();
    const scene = ensureScene();
    const r = 0.05;
    const left = createFixation({ type: 'bolt_hole', x: 0.2, y: 0.5, z: 0.5, axis: 'z', radius: r });
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
    scene.fixations.push(left, right);
    linkFeatures(scene, left.id, right.id, dims());
    select('fixation', right.id);
  }

  /* ------------------------------ Object list events ------------------------------ */
  on($('list-scene-objects'), 'click', (e) => {
    const li = e.target.closest('[data-id]');
    if (li) selectItem(/** @type {'fixation'|'force'} */ (li.dataset.kind), li.dataset.id);
  });
  on($('list-scene-objects'), 'keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const li = e.target.closest?.('[data-id]');
    if (!li) return;
    e.preventDefault();
    selectItem(/** @type {'fixation'|'force'} */ (li.dataset.kind), li.dataset.id);
  });

  on($('btn-add-rest'), 'click', () => addFixation('rest_point'));
  on($('btn-add-bolt-hole'), 'click', () => addFixation('bolt_hole'));
  on($('btn-add-bolt-loaded'), 'click', () => addLoadedHole());
  on($('btn-add-wall-pad'), 'click', () => addFixation('wall_pad'));
  on($('btn-add-point-load'), 'click', () => addForce('point_load'));
  on($('btn-add-pressure'), 'click', () => addForce('pressure'));
  on($('btn-add-bolt-pair'), 'click', () => addBoltPair());

  /* ------------------------------ Examples ------------------------------ */
  const examplesEl = $('scene-examples');
  if (examplesEl) {
    examplesEl.innerHTML = SCENE_EXAMPLES.map(
      (ex) => `<button type="button" class="btn-secondary !py-1.5 text-[10px]" data-example="${ex.id}" title="${ex.blurb}">
        <i class="ph ${ex.icon ?? 'ph-cube'}"></i> ${ex.title}
      </button>`,
    ).join('');
    on(examplesEl, 'click', (e) => {
      const btn = e.target.closest('[data-example]');
      const ex = btn && SCENE_EXAMPLES.find((s) => s.id === btn.dataset.example);
      if (!ex) return;
      pushUndo();
      // Switch to the grid the example was tuned for BEFORE building / fitting the scene.
      if (ex.resolution && ex.resolution !== `${config.nx}x${config.ny}x${config.nz}`) {
        onResolution?.(ex.resolution);
      }
      config.scene = normalizeScene(ex.build());
      ensureWorkingVolume(config.scene, dims());
      config.scene.workingVolume.mode = 'auto';
      config.scene.workingVolume.bounds = computeAutoWorkingBounds(
        config.scene,
        config.scene.workingVolume.padding ?? 0.06,
        dims(),
      );
      if (typeof ex.volfrac === 'number') {
        config.volfrac = ex.volfrac;
        const volInput = $('input-volfrac');
        const volLabel = $('val-volfrac');
        if (volInput) volInput.value = String(ex.volfrac);
        if (volLabel) volLabel.textContent = ex.volfrac.toFixed(2);
      }
      selected = null;
      onSelect?.(null);
      notify(false);
    });
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
            : 'Edit the normalized AABB. Outside = void.';
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
    const manual = wv.mode === 'manual';
    for (const id of ['wv-x0', 'wv-x1', 'wv-y0', 'wv-y1', 'wv-z0', 'wv-z1']) {
      const el = $(id);
      if (el) el.disabled = !manual;
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
    wv.padding = Math.max(0, Math.min(0.4, Number.isFinite(v) ? v : 0.06));
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
    refresh: () => notify(false),
    selectItem,
    getSelected: () => selected,
    clearScene,
    dispose: () => ac.abort(),
  };
}
