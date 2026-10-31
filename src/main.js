import { createConfig } from './config/defaults.js';
import { initThreeScene } from './viz/scene.js';
import { rebuildDomainAndMesh } from './viz/instancedVoxels.js';
import { updateVisualization } from './viz/updateVisualization.js';
import {
  createSmoothBody,
  updateSmoothBody,
  setSmoothBodyVisible,
  resetSmoothBody,
} from './viz/smoothBody.js';
import {
  createDesignVolume,
  updateDesignVolume,
  setDesignVolumeVisible,
} from './viz/designVolume.js';
import { groundY } from './viz/coordinates.js';
import { WorkerClient } from './bridge/workerClient.js';
import { MetricsCollector } from './perf/metricsCollector.js';
import { SystemSampler } from './perf/systemSampler.js';
import { PerformanceMonitor } from './perf/PerformanceMonitor.js';
import { bindAll } from './ui/bindings.js';
import { createSceneGizmoController } from './viz/sceneGizmos.js';

const $ = (id) => document.getElementById(id);

const config = createConfig();

/* ---------------- Scene ---------------- */
const sceneApi = initThreeScene({
  container: $('viewport'),
  canvas: $('three-canvas'),
});

const smoothBody = createSmoothBody(sceneApi.scene);
const designVolume = createDesignVolume(sceneApi.scene);

/** @type {import('three').InstancedMesh | null} */
let mesh = null;
/** Latest solver fields (null until first STATE_UPDATE for the current grid). */
let fields = null;
/** @type {ReturnType<typeof bindAll> | null} */
let ui = null;

function rebuild(cfg) {
  mesh = rebuildDomainAndMesh(cfg, { scene: sceneApi.scene, previous: mesh });
  sceneApi.setGroundY(groundY(cfg));
  sceneApi.frameDomain(cfg);
  updateDesignVolume(designVolume, cfg);
  fields = null;
  resetSmoothBody(smoothBody);
}

smoothBody.onMesh = () => sceneApi.invalidateShadows();

let lastVizMs = 0;
let lastRedrawEnd = 0;
let redrawQueued = false;

function redraw() {
  if (!fields) return;
  const t0 = performance.now();
  const ok = updateVisualization({ mesh, ...fields, config });

  if (config.viewMode === 'smooth') {
    // Meshing runs in a worker (latest-wins); the shadow map refreshes when it lands.
    updateSmoothBody(smoothBody, {
      densities: fields.densities,
      config,
      iso: config.smoothIso ?? 0.45,
      smoothIters: config.smoothIters ?? 4,
    });
  } else {
    setSmoothBodyVisible(smoothBody, false);
    if (ok) sceneApi.invalidateShadows();
  }

  lastRedrawEnd = performance.now();
  if (ok) lastVizMs = lastRedrawEnd - t0;
  return ok ? lastVizMs : undefined;
}
sceneApi.redraw = redraw;

function scheduleRedraw() {
  if (redrawQueued) return;
  redrawQueued = true;
  const tick = () => {
    // Keep the main thread ≥ ~2/3 free: wait 2× the last redraw cost between redraws.
    if (performance.now() - lastRedrawEnd < lastVizMs * 2) {
      requestAnimationFrame(tick);
      return;
    }
    redrawQueued = false;
    redraw();
  };
  requestAnimationFrame(tick);
}

/* ---------------- Perf ---------------- */
const metrics = new MetricsCollector({ capacity: 300 });
const sampler = new SystemSampler(sceneApi.renderer);
const monitor = new PerformanceMonitor($('perf-monitor'), metrics);

/* ---------------- Telemetry ---------------- */
let fpsFrames = 0;
let fpsStamp = performance.now();
let currentFps = 60;
let solveCounter = 0;
let solveHz = 0;
let lastSolveMs = 0;

function renderSpeed() {
  const el = $('stat-speed');
  if (el) {
    el.innerHTML = `${solveHz.toFixed(1)} Hz <span class="text-[10px] font-normal text-slate-400">(${Math.round(lastSolveMs)} ms)</span>`;
  }
}

function setBackend(name) {
  const label = name || 'CPU';
  const badge = $('badge-backend');
  if (badge) {
    badge.textContent = `Worker · ${label}`;
    badge.dataset.backend = /gpu/i.test(label) ? 'gpu' : 'cpu';
  }
  monitor.setBackendBadge(label);
}

function renderTelemetry(meta) {
  $('stat-iter').textContent = meta.iteration ?? 0;
  $('stat-compliance').textContent = (meta.compliance ?? 0).toFixed(2);
  $('stat-cg-res').textContent = (meta.cgResidual ?? 0).toExponential(2);
  const vol = meta.avgVolume ?? config.volfrac;
  $('stat-vol').textContent = `${vol.toFixed(3)} / ${config.volfrac.toFixed(3)}`;
  renderSpeed();
}

/* ---------------- Worker ---------------- */
const workerClient = new WorkerClient((update) => {
  const { kind, meta, densities, energies, dispY, roundTripMs } = update;

  if (meta.backend) setBackend(meta.backend);
  if (meta.error) console.error('[worker]', meta.error);
  if (meta.backendNote) console.info('[worker]', meta.backendNote);

  const expected = config.nx * config.ny * config.nz;
  if (densities.length !== expected) return;

  fields = { densities, energies, dispY };
  // Visualization is coalesced to the display rate and never takes more than ~1/3 of the
  // main thread, however fast the solver streams updates.
  scheduleRedraw();
  const vizMs = lastVizMs > 0 ? lastVizMs : undefined;

  if (kind === 'step') {
    const batch = meta.batchSteps || 1;
    solveCounter += batch;
    lastSolveMs = roundTripMs;
    const tm = meta.timings ?? {};
    metrics.update({
      compliance: meta.compliance,
      cgResidual: meta.cgResidual,
      feaMs: tm.feaMs,
      filterOcMs: tm.filterOcMs,
      vizMs,
    });
  } else if (vizMs !== undefined) {
    metrics.update({ vizMs });
  }

  renderTelemetry(meta);
  ui?.stage?.onUpdate(update);
});

/* ---------------- Bindings ---------------- */
workerClient.start();

/* Custom-scene gizmos (draggable supports / loads); active only on the Custom Scene tab. */
const gizmos = createSceneGizmoController({
  scene: sceneApi.scene,
  camera: sceneApi.camera,
  domElement: sceneApi.renderer.domElement,
  controls: sceneApi.controls,
  getConfig: () => config,
  onSceneChanged: () => {
    ui?.sceneEditor?.refresh();
    sceneApi.invalidateShadows?.();
  },
  onSelect: (sel) => {
    if (sel) ui?.sceneEditor?.selectItem(sel.kind, sel.id, { fromGizmo: true });
    else ui?.sceneEditor?.selectItem(null, null, { fromGizmo: true });
  },
});

ui = bindAll({
  config,
  workerClient,
  sceneApi,
  metrics,
  onRebuild: rebuild,
  getDensities: () => fields?.densities ?? null,
  onSceneChange: () => {
    gizmos.syncFromScene();
    updateDesignVolume(designVolume, config);
  },
  onSceneSelect: (sel) => {
    gizmos.selectById(sel?.id ?? null);
  },
  onTabChange: (name) => {
    const onScene = name === 'scene';
    gizmos.setEnabled(onScene);
    // Brighter envelope while editing BCs; keep a faint ghost on Optimize.
    if (designVolume.fill?.material) {
      designVolume.fill.material.opacity = onScene ? 0.1 : 0.045;
    }
    if (designVolume.edges?.material) {
      designVolume.edges.material.opacity = onScene ? 0.55 : 0.28;
    }
    updateDesignVolume(designVolume, config);
    setDesignVolumeVisible(designVolume, true);
  },
});

rebuild(config);
updateDesignVolume(designVolume, config);
setDesignVolumeVisible(designVolume, true);
ui.resetSimulation();

/* ---------------- Render loop ---------------- */
let lastSample = performance.now();
let sysCache = sampler.sample();

function frame(now) {
  requestAnimationFrame(frame);

  sceneApi.render();
  fpsFrames++;

  const fpsDt = now - fpsStamp;
  if (fpsDt >= 1000) {
    currentFps = (fpsFrames * 1000) / fpsDt;
    solveHz = (solveCounter * 1000) / fpsDt;
    fpsFrames = 0;
    solveCounter = 0;
    fpsStamp = now;
    $('stat-fps').textContent = `${Math.round(currentFps)} FPS`;
    renderSpeed();
    sysCache = sampler.sample();
    monitor.setSystemInfo(sysCache);
  }

  if (now - lastSample >= 100) {
    lastSample = now;
    metrics.pushSample({ fps: currentFps, solveHz, heapMb: sysCache.heapMb }, now);
  }
  monitor.update(metrics, now);
}
requestAnimationFrame(frame);

window.addEventListener('beforeunload', () => {
  workerClient.terminate();
  ui.dispose();
  gizmos.dispose();
});

window.__topo = {
  config,
  sceneApi,
  workerClient,
  metrics,
  monitor,
  ui,
  smoothBody,
  designVolume,
  gizmos,
};
