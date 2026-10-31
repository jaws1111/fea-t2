import { updateBoundaryFixtures } from '../viz/boundaryFixtures.js';
import { getRampCssGradient } from '../viz/colormaps.js';

import { bindSceneEditor } from './sceneEditor.js';
import { bindStageOptimizer } from './stageOptimizer.js';
import { createTwoBoltBracketScene } from '../scene/templates.js';
import { normalizeScene } from '../scene/types.js';

const PRESETS = [
  { id: 'preset-bridge', key: 'bridge' },
  { id: 'preset-deck', key: 'deck' },
  { id: 'preset-cantilever', key: 'cantilever' },
  { id: 'preset-mbb', key: 'mbb' },
  { id: 'preset-michell', key: 'michell' },
  { id: 'preset-custom', key: 'custom' },
];

const VIEWS = [
  { id: 'view-density', mode: 'density' },
  { id: 'view-viridis', mode: 'viridis' },
  { id: 'view-metal', mode: 'metal' },
  { id: 'view-energy', mode: 'energy' },
  { id: 'view-smooth', mode: 'smooth' },
];

const LEGEND_LABELS = {
  density: ['Void', 'Solid (1.0)'],
  viridis: ['Void', 'Solid (1.0)'],
  metal: ['Void', 'Solid (1.0)'],
  energy: ['Low strain', 'High strain'],
  smooth: ['Iso surface', 'Solid body'],
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
      preset: config.preset,
      // Always hand the worker a current-schema scene (migrates legacy saves).
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
    for (const p of PRESETS) {
      const el = $(p.id);
      if (!el) continue;
      const active = p.key === config.preset;
      el.classList.toggle('is-active', active);
      el.setAttribute('aria-pressed', String(active));
    }
  }

  function renderViewButtons() {
    for (const v of VIEWS) {
      const el = $(v.id);
      if (!el) continue;
      const active = v.mode === config.viewMode;
      el.classList.toggle('is-active', active);
      el.setAttribute('aria-pressed', String(active));
    }
    const ramp = $('legend-ramp');
    if (ramp) ramp.style.background = getRampCssGradient(config.viewMode);
    const [lo, hi] = LEGEND_LABELS[config.viewMode] ?? LEGEND_LABELS.density;
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
    if (![...sel.options].some((o) => o.value === key)) {
      const opt = document.createElement('option');
      opt.value = key;
      opt.dataset.dyn = '1';
      opt.textContent = `Stage grid (${config.nx}×${config.ny}×${config.nz} = ${total.toLocaleString()})`;
      sel.appendChild(opt);
    }
    sel.value = key;
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

  /* ---------------- Presets ---------------- */
  for (const p of PRESETS) {
    on($(p.id), 'click', () => {
      config.preset = p.key;
      if (p.key === 'custom') {
        if (!config.scene || (!config.scene.fixations?.length && !config.scene.forces?.length)) {
          config.scene = createTwoBoltBracketScene();
        }
        sceneEditor.showTab('scene');
      }
      renderPresetButtons();
      resetSimulation();
    });
  }

  /* ---------------- Sliders ---------------- */
  on($('input-batch'), 'input', (e) => {
    config.batchSize = parseInt(e.target.value, 10);
    workerClient.batchSize = config.batchSize;
    renderSliderLabels();
  });

  on($('input-volfrac'), 'input', (e) => {
    config.volfrac = parseFloat(e.target.value);
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
  on($('select-res'), 'change', (e) => {
    setRunning(false);
    const [nx, ny, nz] = e.target.value.split('x').map(Number);
    config.nx = nx;
    config.ny = ny;
    config.nz = nz;
    renderResolution();
    onRebuild(config);
    resetSimulation();
  });

  /* ---------------- View modes ---------------- */
  for (const v of VIEWS) {
    on($(v.id), 'click', () => {
      config.viewMode = v.mode;
      renderViewButtons();
      sceneApi.redraw?.();
    });
  }

  on($('btn-reset-cam'), 'click', () => sceneApi.resetCamera?.(config));

  const sceneEditor = bindSceneEditor({
    config,
    onResolution: (key) => {
      const [nx, ny, nz] = key.split('x').map(Number);
      if (![nx, ny, nz].every((v) => Number.isFinite(v) && v > 0)) return;
      setRunning(false);
      config.nx = nx;
      config.ny = ny;
      config.nz = nz;
      renderResolution();
      onRebuild(config);
      stageApi?.invalidate();
    },
    onApply: () => {
      config.preset = 'custom';
      renderPresetButtons();
      resetSimulation();
    },
    onChange: () => {
      // Always preview fixtures from the draft scene while editing / when custom.
      if (sceneApi.fixturesGroup) {
        const previewCfg =
          config.preset === 'custom' || sceneEditorActive()
            ? { ...config, preset: 'custom', scene: config.scene }
            : config;
        updateBoundaryFixtures(sceneApi.fixturesGroup, previewCfg);
        sceneApi.invalidateShadows?.();
      }
      onSceneChange?.();
    },
    onClear: () => {
      // Drop applied custom BCs and wipe the density field so Clear is visible.
      if (config.preset === 'custom') {
        config.preset = 'custom';
        resetSimulation();
      } else if (sceneApi.fixturesGroup) {
        updateBoundaryFixtures(sceneApi.fixturesGroup, {
          ...config,
          preset: 'custom',
          scene: config.scene,
        });
        sceneApi.invalidateShadows?.();
      }
      onSceneChange?.();
    },
    onTabChange: (name) => {
      onTabChange?.(name);
      // Refresh fixture preview when entering the scene tab.
      if (name === 'scene' && sceneApi.fixturesGroup) {
        updateBoundaryFixtures(sceneApi.fixturesGroup, {
          ...config,
          preset: 'custom',
          scene: config.scene,
        });
      }
    },
    onSelect: onSceneSelect,
  });

  function sceneEditorActive() {
    return !$('panel-scene')?.classList.contains('hidden');
  }

  /** Switch grid (and optionally warm-start) for the Stage Optimizer. */
  function applyStage(dims, { init = null, rmin, clearMetrics = true } = {}) {
    // Compliance scales with grid size, so graphs restart on every stage.
    setRunning(false);
    config.nx = dims.nx;
    config.ny = dims.ny;
    config.nz = dims.nz;
    if (Number.isFinite(rmin)) config.rmin = rmin;
    renderResolution();
    renderSliderLabels();
    const rminInput = $('input-rmin');
    if (rminInput) rminInput.value = String(config.rmin);
    onRebuild(config);
    resetSimulation({ fromStage: true, init, clearMetrics });
  }

  stageApi = bindStageOptimizer({
    config,
    workerClient,
    getDensities: () => getDensities?.() ?? null,
    setRunning,
    isRunning: () => running,
    applyStage,
  });

  syncUI();

  return {
    setRunning,
    isRunning: () => running,
    resetSimulation,
    syncUI,
    sceneEditor,
    stage: stageApi,
    dispose: () => {
      stageApi?.dispose();
      sceneEditor.dispose();
      ac.abort();
    },
  };
}
