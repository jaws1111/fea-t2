import { updateBoundaryFixtures } from '../viz/boundaryFixtures.js';
import { getRampCssGradient } from '../viz/colormaps.js';

import { bindSceneEditor } from './sceneEditor.js';
import { bindStageOptimizer } from './stageOptimizer.js';
import { isSceneEmpty, normalizeScene } from '../scene/types.js';
import { fitDimsForBudget, fitGridForBounds, fitGridForScene } from '../scene/domainFit.js';
import { resolveRecipe } from '../library/apply.js';
import { getRecipe } from '../library/store.js';

const SHORTCUT_IDS = [
  'preset-bridge',
  'preset-deck',
  'preset-cantilever',
  'preset-mbb',
  'preset-michell',
  'preset-custom',
];

/** Level 1: how the design is drawn. */
const REPRESENTATIONS = [
  { id: 'view-cubes', mode: 'cubes' },
  { id: 'view-smooth', mode: 'smooth' },
];

/** Level 2: what the colour shows (applies to both representations). */
const COLOR_MODES = [
  { id: 'view-density', mode: 'density' },
  { id: 'view-viridis', mode: 'viridis' },
  { id: 'view-metal', mode: 'metal' },
  { id: 'view-energy', mode: 'energy' },
];

const LEGEND_LABELS = {
  density: ['Void', 'Solid (1.0)'],
  viridis: ['Void', 'Solid (1.0)'],
  metal: ['Void', 'Solid (1.0)'],
  energy: ['Low strain', 'High strain'],
};

const $ = (id) => document.getElementById(id);

/**
 * Wire every studio control to config / worker / scene.
 *
 * @param {{
 *   config: ReturnType<typeof import('../config/defaults.js').createConfig>,
 *   workerClient: import('../bridge/workerClient.js').WorkerClient,
 *   sceneApi: ReturnType<typeof import('../viz/scene.js').initThreeScene>,
 *   metrics: import('../perf/metricsCollector.js').MetricsCollector,
 *   onRebuild: (config: object) => void,
 *   onSceneChange?: () => void,
 *   onTabChange?: (name: 'optimize'|'scene') => void,
 *   onSceneSelect?: (sel: { kind: 'fixation'|'force', id: string } | null) => void,
 * }} deps
 *   `onRebuild` must rebuild the voxel mesh for the new grid size (the bindings
 *   then reset the worker + fixtures). `sceneApi.redraw()` is invoked for
 *   display-only changes (view mode, cutoff, deformation).
 */
export function bindAll({
  config,
  workerClient,
  sceneApi,
  metrics,
  onRebuild,
  onSceneChange,
  onTabChange,
  onSceneSelect,
  getDensities,
}) {
  const ac = new AbortController();
  const { signal } = ac;
  const on = (el, type, fn) => el?.addEventListener(type, fn, { signal });

  let running = false;
  /** @type {ReturnType<typeof bindStageOptimizer> | null} */
  let stageApi = null;

  /* ---------------- Run state ---------------- */
  function renderRunButton() {
    stageApi?.sync();
    const btn = $('btn-toggle-run');
    if (!btn) return;
    const icon = btn.querySelector('i');
    const label = btn.querySelector('span');
    btn.classList.toggle('is-running', running);
    btn.setAttribute('aria-pressed', String(running));
    if (icon) icon.className = running ? 'ph-fill ph-pause text-sm' : 'ph-fill ph-play text-sm';
    if (label) label.textContent = running ? 'Pause Optimization' : 'Start Optimization Loop';
  }

  function setRunning(run) {
    running = !!run;
    renderRunButton();
    workerClient.setRunning(running);
  }

  /* ---------------- Reset ---------------- */
  function resetPayload(init = null) {
    return {
      // Warm-start field from another grid (Stage Optimizer); resampled in the worker.
      initDensity: init ?? undefined,
      nx: config.nx,
      ny: config.ny,
      nz: config.nz,
      volfrac: config.volfrac,
      penal: config.penal,
      rmin: config.rmin,
      // Saved scenes from older builds still need the current schema.
      scene: config.scene ? normalizeScene(config.scene) : null,
    };
  }

  /** Stop, clear telemetry history, rebuild fixtures and re-initialise the worker. */
  function resetSimulation(opts = {}) {
    const { fromStage = false, init = null, clearMetrics = true } = opts ?? {};
    setRunning(false);
    if (!fromStage) stageApi?.invalidate();
    if (clearMetrics) metrics?.clear();
    workerClient.reset(resetPayload(init));
    if (sceneApi.fixturesGroup) updateBoundaryFixtures(sceneApi.fixturesGroup, config);
    sceneApi.invalidateShadows?.();
    onSceneChange?.();
  }

  /* ---------------- Visual helpers ---------------- */
  function renderPresetButtons() {
    for (const id of SHORTCUT_IDS) {
      const el = $(id);
      if (!el) continue;
      const recipe = el.dataset.recipe || null;
      const active = recipe ? config.recipeId === recipe : !config.recipeId;
      el.classList.toggle('is-active', active);
      el.setAttribute('aria-pressed', String(active));
    }
  }

  function renderViewButtons() {
    const mark = (list, current) => {
      for (const v of list) {
        const el = $(v.id);
        if (!el) continue;
        const active = v.mode === current;
        el.classList.toggle('is-active', active);
        el.setAttribute('aria-pressed', String(active));
      }
    };
    mark(REPRESENTATIONS, config.viewMode);
    mark(COLOR_MODES, config.colorMode);
    // Smooth-body specific controls only matter for that representation.
    $('group-smooth-body')?.classList.toggle('hidden', config.viewMode !== 'smooth');
    const ramp = $('legend-ramp');
    if (ramp) ramp.style.background = getRampCssGradient(config.colorMode);
    const [lo, hi] = LEGEND_LABELS[config.colorMode] ?? LEGEND_LABELS.density;
    if ($('legend-min')) $('legend-min').textContent = lo;
    if ($('legend-max')) $('legend-max').textContent = hi;
  }

  function renderResolution() {
    const total = config.nx * config.ny * config.nz;
    const label = $('label-res');
    if (label) label.textContent = `${config.nx} x ${config.ny} x ${config.nz} (${total.toLocaleString()})`;
    const sel = $('select-res');
    const key = `${config.nx}x${config.ny}x${config.nz}`;
    if (!sel) return;
    // Grids produced by the Stage Optimizer aren't in the preset list: show them as a temporary entry.
    sel.querySelectorAll('option[data-dyn]').forEach((o) => o.remove());
    // A custom-scene grid fitted to the working volume keeps showing the voxel preset it
    // was derived from (its dims follow the volume's proportions, not the preset's).
    const fromPreset = !!config.resKey && [...sel.options].some((o) => o.value === config.resKey);
    if (!fromPreset && ![...sel.options].some((o) => o.value === key)) {
      const opt = document.createElement('option');
      opt.value = key;
      opt.dataset.dyn = '1';
      opt.textContent = `${total.toLocaleString()} voxels (current grid)`;
      sel.appendChild(opt);
    }
    sel.value = fromPreset ? config.resKey : key;
  }

  function renderSliderLabels() {
    const set = (id, text) => {
      const el = $(id);
      if (el) el.textContent = text;
    };
    set('val-batch', String(config.batchSize));
    set('val-volfrac', config.volfrac.toFixed(2));
    set('val-penal', config.penal.toFixed(1));
    set('val-rmin', config.rmin.toFixed(1));
    set('val-cutoff', config.cutoff.toFixed(2));
    set('val-defscale', `${config.defScale}x`);
    set('val-smooth-iso', (config.smoothIso ?? 0.45).toFixed(2));
    set('val-smooth-iters', String(config.smoothIters ?? 4));
    set('label-step', `Step ${config.batchSize} Iter`);
  }

  /** Push config values into the DOM controls (call once after binding). */
  function syncUI() {
    const setVal = (id, v) => {
      const el = $(id);
      if (el) el.value = String(v);
    };
    setVal('input-batch', config.batchSize);
    setVal('input-volfrac', config.volfrac);
    setVal('input-penal', config.penal);
    setVal('input-rmin', config.rmin);
    setVal('input-cutoff', config.cutoff);
    setVal('input-defscale', config.defScale);
    setVal('input-smooth-iso', config.smoothIso ?? 0.45);
    setVal('input-smooth-iters', config.smoothIters ?? 4);
    if ($('input-ao')) $('input-ao').checked = config.ao !== false;
    workerClient.batchSize = config.batchSize;
    renderSliderLabels();
    renderResolution();
    renderPresetButtons();
    renderViewButtons();
    renderRunButton();
  }

  /* ---------------- Run / step / reset ---------------- */
  on($('btn-toggle-run'), 'click', () => setRunning(!running));

  on($('btn-step'), 'click', () => {
    if (running) setRunning(false);
    workerClient.step(config.batchSize);
  });

  on($('btn-reset'), 'click', () => resetSimulation());

  /**
   * Load a library recipe into the draft scene and, when `simulate` is set, rebuild the solver.
   * `loadScene` clears `recipeId` via undo, so the id is written after that call.
   */
  function loadLibraryRecipe(recipeId, { simulate }) {
    const recipe = getRecipe(recipeId);
    if (!recipe) return;
    const resolved = resolveRecipe(recipe, currentBudget());
    const cur = `${config.nx}x${config.ny}x${config.nz}`;
    const listed = [...($('select-res')?.options ?? [])].some((o) => !o.dataset.dyn && o.value === cur);
    const key = config.resKey ?? (listed ? cur : null);
    const changed =
      resolved.dims.nx !== config.nx || resolved.dims.ny !== config.ny || resolved.dims.nz !== config.nz;
    config.nx = resolved.dims.nx;
    config.ny = resolved.dims.ny;
    config.nz = resolved.dims.nz;
    config.resKey = key;
    if (Number.isFinite(resolved.volfrac)) {
      config.volfrac = resolved.volfrac;
      const volInput = $('input-volfrac');
      if (volInput) volInput.value = String(resolved.volfrac);
    }
    if (Number.isFinite(resolved.rmin)) {
      config.rmin = resolved.rmin;
      const rminInput = $('input-rmin');
      if (rminInput) rminInput.value = String(resolved.rmin);
    }
    sceneEditor.loadScene(resolved.scene);
    config.recipeId = recipeId;
    sceneEditor.highlightRecipe();
    renderSliderLabels();
    renderResolution();
    renderPresetButtons();
    if (changed) onRebuild(config);
    if (simulate) resetSimulation();
  }

  /* ---------------- Presets ---------------- */
  for (const id of SHORTCUT_IDS) {
    on($(id), 'click', () => {
      const recipe = $(id)?.dataset.recipe || null;
      if (!recipe) {
        config.recipeId = null;
        if (isSceneEmpty(config.scene)) {
          const fallback = getRecipe('builtin:two_bolt_bracket');
          if (fallback) sceneEditor.loadScene(fallback.scene);
          config.recipeId = null;
        }
        sceneEditor.highlightRecipe();
        sceneEditor.showTab('scene');
        renderPresetButtons();
        return;
      }
      loadLibraryRecipe(recipe, { simulate: true });
    });
  }

  /* ---------------- Sliders ---------------- */
  on($('input-batch'), 'input', (e) => {
    config.batchSize = parseInt(e.target.value, 10);
    workerClient.batchSize = config.batchSize;
    renderSliderLabels();
  });

  on($('input-volfrac'), 'input', (e) => {
    config.volfrac = Math.max(0.1, parseFloat(e.target.value) || 0.35);
    renderSliderLabels();
    workerClient.updateParams({ volfrac: config.volfrac });
  });

  on($('input-penal'), 'input', (e) => {
    config.penal = parseFloat(e.target.value);
    renderSliderLabels();
    workerClient.updateParams({ penal: config.penal });
  });

  on($('input-rmin'), 'input', (e) => {
    config.rmin = parseFloat(e.target.value);
    renderSliderLabels();
    workerClient.updateParams({ rmin: config.rmin });
  });

  on($('input-cutoff'), 'input', (e) => {
    config.cutoff = parseFloat(e.target.value);
    renderSliderLabels();
    sceneApi.redraw?.();
  });

  on($('input-ao'), 'change', (e) => {
    config.ao = !!e.target.checked;
    sceneApi.redraw?.();
  });

  on($('input-defscale'), 'input', (e) => {
    config.defScale = parseFloat(e.target.value);
    renderSliderLabels();
    sceneApi.redraw?.();
  });

  on($('input-smooth-iso'), 'input', (e) => {
    config.smoothIso = parseFloat(e.target.value);
    renderSliderLabels();
    sceneApi.redraw?.();
  });

  on($('input-smooth-iters'), 'input', (e) => {
    config.smoothIters = parseInt(e.target.value, 10);
    renderSliderLabels();
    sceneApi.redraw?.();
  });

  /* ---------------- Resolution ---------------- */
  /**
   * Custom scenes treat a voxel preset as a CELL BUDGET: the grid takes the proportions of
   * the working volume (and the scene is cropped to it) instead of the preset's fixed aspect.
   */
  function applyGridBudget(budget, key) {
    const fit = fitGridForScene(config.scene, { nx: config.nx, ny: config.ny, nz: config.nz }, budget);
    config.nx = fit.dims.nx;
    config.ny = fit.dims.ny;
    config.nz = fit.dims.nz;
    config.resKey = key;
    if (fit.cropped) sceneEditor.replaceScene(fit.scene);
  }

  const hasScene = () => !!config.scene && !isSceneEmpty(config.scene);

  on($('select-res'), 'change', (e) => {
    setRunning(false);
    const [nx, ny, nz] = e.target.value.split('x').map(Number);
    const budget = nx * ny * nz;
    const recipe = config.recipeId ? getRecipe(config.recipeId) : null;
    const classic = recipe?.meta?.domain && !Number.isFinite(recipe.meta.domain.budget);
    if (classic) {
      const d = fitDimsForBudget(recipe.meta.domain, budget);
      config.nx = d.nx;
      config.ny = d.ny;
      config.nz = d.nz;
      config.resKey = e.target.value;
    } else if (hasScene()) {
      applyGridBudget(budget, e.target.value);
    } else {
      const d = fitDimsForBudget({ x: config.nx, y: config.ny, z: config.nz }, budget);
      config.nx = d.nx;
      config.ny = d.ny;
      config.nz = d.nz;
      config.resKey = e.target.value;
    }
    renderResolution();
    onRebuild(config);
    resetSimulation();
  });

  /** Scene tab: crop the domain to the working volume at the current cell count. */
  function fitDomainToVolume() {
    if (!hasScene()) return;
    setRunning(false);
    applyGridBudget(config.nx * config.ny * config.nz, null);
    renderResolution();
    onRebuild(config);
    resetSimulation();
  }

  /* ---------------- View modes ---------------- */
  for (const v of REPRESENTATIONS) {
    on($(v.id), 'click', () => {
      config.viewMode = v.mode;
      renderViewButtons();
      sceneApi.redraw?.();
    });
  }
  for (const v of COLOR_MODES) {
    on($(v.id), 'click', () => {
      config.colorMode = v.mode;
      renderViewButtons();
      sceneApi.redraw?.();
    });
  }

  on($('btn-reset-cam'), 'click', () => sceneApi.resetCamera?.(config));

  const sceneEditor = bindSceneEditor({
    config,
    onFitDomain: fitDomainToVolume,
    onLoadRecipe: (recipeId) => {
      setRunning(false);
      loadLibraryRecipe(recipeId, { simulate: false });
      stageApi?.invalidate();
    },
    onApply: () => {
      renderPresetButtons();
      resetSimulation();
    },
    onChange: () => {
      renderPresetButtons();
      if (sceneApi.fixturesGroup) {
        updateBoundaryFixtures(sceneApi.fixturesGroup, config);
        sceneApi.invalidateShadows?.();
      }
      onSceneChange?.();
    },
    onClear: () => {
      resetSimulation();
    },
    onTabChange: (name) => {
      onTabChange?.(name);
      if (name === 'scene' && sceneApi.fixturesGroup) {
        updateBoundaryFixtures(sceneApi.fixturesGroup, config);
      }
    },
    onSelect: onSceneSelect,
  });

  /** Switch grid (and optionally warm-start) for the Stage Optimizer. */
  function applyStage(dims, { init = null, rmin, clearMetrics = true } = {}) {
    // Compliance scales with grid size, so graphs restart on every stage.
    setRunning(false);
    config.nx = dims.nx;
    config.ny = dims.ny;
    config.nz = dims.nz;
    config.resKey = null;
    if (Number.isFinite(rmin)) config.rmin = rmin;
    renderResolution();
    renderSliderLabels();
    const rminInput = $('input-rmin');
    if (rminInput) rminInput.value = String(config.rmin);
    onRebuild(config);
    resetSimulation({ fromStage: true, init, clearMetrics });
  }

  /* ---------------- Working-volume corner handles ---------------- */

  /** Cell budget of the Voxel Domain setting (the chosen preset, else the current cell count). */
  function currentBudget() {
    const key = config.resKey ?? `${config.nx}x${config.ny}x${config.nz}`;
    const [a, b, c] = key.split('x').map(Number);
    return a * b * c;
  }

  /** Live readout while a corner is dragged: the grid the box will be meshed into. */
  function previewWorkingVolume(bounds) {
    const el = $('wv-size');
    if (!el) return;
    if (!bounds) return;
    const size = {
      x: Math.max(1e-3, (bounds.x1 - bounds.x0) * config.nx),
      y: Math.max(1e-3, (bounds.y1 - bounds.y0) * config.ny),
      z: Math.max(1e-3, (bounds.z1 - bounds.z0) * config.nz),
    };
    const d = fitDimsForBudget(size, currentBudget());
    const shape = config.scene?.workingVolume?.shape;
    const name = shape === 'sphere' ? 'Sphere' : shape === 'cylinder' ? 'Cylinder' : 'Box';
    el.textContent = `${name} → ${d.nx} × ${d.ny} × ${d.nz} = ${(d.nx * d.ny * d.nz).toLocaleString()} cubic voxels`;
  }

  /** Corner drag released: crop / grow the domain to the box and mesh it at the preset budget. */
  function commitWorkingVolume(bounds) {
    setRunning(false);
    const cur = `${config.nx}x${config.ny}x${config.nz}`;
    const listed = [...($('select-res')?.options ?? [])].some((o) => !o.dataset.dyn && o.value === cur);
    const key = config.resKey ?? (listed ? cur : null);
    const fit = fitGridForBounds(config.scene, { nx: config.nx, ny: config.ny, nz: config.nz }, bounds, currentBudget());
    config.nx = fit.dims.nx;
    config.ny = fit.dims.ny;
    config.nz = fit.dims.nz;
    config.resKey = key;
    sceneEditor.replaceScene(fit.scene);
    renderResolution();
    onRebuild(config);
    stageApi?.invalidate();
    resetSimulation();
  }
  stageApi = bindStageOptimizer({
    config,
    workerClient,
    getDensities: () => getDensities?.() ?? null,
    setRunning,
    isRunning: () => running,
    applyStage,
  });

  loadLibraryRecipe('builtin:bridge', { simulate: false });
  syncUI();

  return {
    setRunning,
    isRunning: () => running,
    resetSimulation,
    syncUI,
    sceneEditor,
    previewWorkingVolume,
    commitWorkingVolume,
    stage: stageApi,
    dispose: () => {
      stageApi?.dispose();
      sceneEditor.dispose();
      ac.abort();
    },
  };
}
