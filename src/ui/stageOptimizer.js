import { dimsForVoxelTarget } from '../topo/resample.js';

const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n).toLocaleString('en-US');
const MAX_VOXELS = 400_000;
const MIN_RMIN = 1.1;
const MAX_RMIN = 6;
const CONV_WINDOW = 10;
const CONV_MIN_IT = 20;
/** "Run all stages": never declare a stage converged before this many iterations. */
const AUTO_MIN_IT_COARSE = 30;
const AUTO_MIN_IT_FINAL = 50;

/**
 * Stage Optimizer: multi-grid refinement workflow.
 *
 * Stage 1 starts fresh on a (coarse) grid. While paused, "Refine" captures the current
 * density field, interpolates it onto the next stage's grid (same aspect ratio, more
 * voxels), re-seeds the worker with it (passive regions of a custom scene are re-applied
 * on the new grid) and continues. Earlier results are kept, so you can go "Back" or "Redo".
 *
 * @param {{
 *   config: ReturnType<typeof import('../config/defaults.js').createConfig>,
 *   workerClient: import('../bridge/workerClient.js').WorkerClient,
 *   getDensities: () => Float32Array | null,
 *   setRunning: (run: boolean) => void,
 *   isRunning: () => boolean,
 *   applyStage: (dims: {nx:number,ny:number,nz:number}, opts: {
 *     init: { nx:number, ny:number, nz:number, data: Float32Array, sharpen: number } | null,
 *     rmin?: number, clearMetrics?: boolean }) => void,
 * }} deps
 */
export function bindStageOptimizer({ config, workerClient, getDensities, setRunning, isRunning, applyStage }) {
  const ac = new AbortController();
  const { signal } = ac;
  const on = (el, type, fn) => el?.addEventListener(type, fn, { signal });

  const plan = {
    stages: [
      { target: 24_000, maxIter: 0 },
      { target: 50_000, maxIter: 0 },
      { target: 100_000, maxIter: 0 },
    ],
    /** index of the active stage, -1 = not started */
    current: -1,
    /** grid whose aspect ratio all stages share (fixed at start) */
    base: /** @type {{nx:number,ny:number,nz:number} | null} */ (null),
    /** final field of each completed stage: {nx,ny,nz,data,iteration,compliance,vol} */
    results: /** @type {any[]} */ ([]),
    /** field that started each stage (for Redo) */
    seeds: /** @type {any[]} */ ([]),
    iterAccum: /** @type {number[]} */ ([]),
    hist: /** @type {{ it: number, c: number }[]} */ ([]),
    live: /** @type {{ iteration: number, compliance: number, vol: number } | null} */ (null),
    note: '',
    /** "Run all stages": converge each stage, refine automatically, finish the last one. */
    auto: false,
    autoStartedAt: 0,
  };
  let busy = false;

  /* ------------------------------ helpers ------------------------------ */
  const curDims = () => ({ nx: config.nx, ny: config.ny, nz: config.nz });
  const maxDim = (d) => Math.max(d.nx, d.ny, d.nz);
  const baseDims = () => plan.base ?? curDims();
  const dimsOf = (i) => dimsForVoxelTarget(baseDims(), plan.stages[i].target);
  const lastIndex = () => plan.stages.length - 1;
  const checked = (id) => !!$(id)?.checked;
  const sharpen = () => parseFloat($('stage-opt-sharpen')?.value ?? '0.25') || 0;

  /** Filter radius (cells) giving the same physical length as `physR` (fraction of max dim). */
  function rminFor(dims, physR) {
    if (!checked('stage-opt-rmin')) return config.rmin;
    return Math.min(MAX_RMIN, Math.max(MIN_RMIN, +(physR * maxDim(dims)).toFixed(1)));
  }

  async function waitIdle(ms = 6000) {
    const t0 = performance.now();
    while (workerClient.busy && performance.now() - t0 < ms) {
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /** Pause and snapshot the current field. */
  async function capture() {
    setRunning(false);
    await waitIdle();
    const data = getDensities();
    const n = config.nx * config.ny * config.nz;
    if (!data || data.length !== n) return null;
    const live = plan.live;
    return {
      nx: config.nx,
      ny: config.ny,
      nz: config.nz,
      data: Float32Array.from(data),
      iteration: live?.iteration ?? 0,
      compliance: live?.compliance ?? 0,
      vol: live?.vol ?? config.volfrac,
    };
  }

  function beginStage(note = '') {
    plan.hist = [];
    plan.live = null;
    plan.note = note;
    render();
    if (plan.auto || checked('stage-opt-autorun')) setRunning(true);
  }

  const numInput = (id, d) => {
    const v = parseFloat($(id)?.value ?? '');
    return Number.isFinite(v) && v > 0 ? v : d;
  };

  /** Run every stage in sequence without manual clicks. */
  async function startAuto() {
    if (busy) return;
    if (plan.auto && isRunning()) {
      stopAuto('Auto run paused.');
      return;
    }
    plan.auto = true;
    if (!plan.autoStartedAt || plan.current < 0) plan.autoStartedAt = performance.now();
    if (plan.current < 0) {
      await start();
    } else {
      plan.note = `Auto run: continuing stage ${plan.current + 1} of ${plan.stages.length}.`;
      render();
      setRunning(true);
    }
  }

  function stopAuto(note) {
    plan.auto = false;
    setRunning(false);
    if (note) plan.note = note;
    render();
  }

  /* ------------------------------ actions ------------------------------ */
  async function start() {
    if (busy) return;
    busy = true;
    try {
      setRunning(false);
      plan.base = curDims();
      const physR = config.rmin / maxDim(plan.base);
      plan.results = [];
      plan.seeds = [];
      plan.iterAccum = [];
      plan.current = 0;
      const d = dimsOf(0);
      applyStage(d, { init: null, rmin: rminFor(d, physR), clearMetrics: true });
      beginStage('Stage 1 started from a uniform field.');
    } finally {
      busy = false;
    }
  }

  async function nextStage() {
    if (busy || plan.current < 0 || plan.current >= lastIndex()) return;
    busy = true;
    try {
      const snap = await capture();
      if (!snap) {
        plan.note = 'No density field available yet — run at least one iteration first.';
        render();
        return;
      }
      const cur = plan.current;
      plan.results[cur] = snap;
      plan.iterAccum[cur] = (plan.iterAccum[cur] ?? 0) + snap.iteration;
      const physR = config.rmin / maxDim(curDims());
      const next = cur + 1;
      const d = dimsOf(next);
      const init = { nx: snap.nx, ny: snap.ny, nz: snap.nz, data: snap.data, sharpen: sharpen() };
      plan.seeds[next] = init;
      plan.current = next;
      applyStage(d, { init, rmin: rminFor(d, physR) });
      beginStage(
        `Refined ${snap.nx}×${snap.ny}×${snap.nz} → ${d.nx}×${d.ny}×${d.nz}; continuing from the interpolated field.`,
      );
    } finally {
      busy = false;
    }
  }

  async function prevStage() {
    if (busy || plan.current <= 0) return;
    busy = true;
    try {
      setRunning(false);
      await waitIdle();
      const prev = plan.current - 1;
      const snap = plan.results[prev];
      if (!snap) return;
      const physR = config.rmin / maxDim(curDims());
      plan.results[plan.current] = null;
      plan.current = prev;
      const d = { nx: snap.nx, ny: snap.ny, nz: snap.nz };
      applyStage(d, { init: { ...snap, sharpen: 0 }, rmin: rminFor(d, physR) });
      beginStage(`Back on stage ${prev + 1}, continuing from its last result.`);
    } finally {
      busy = false;
    }
  }

  async function redoStage() {
    if (busy || plan.current < 0) return;
    busy = true;
    try {
      setRunning(false);
      await waitIdle();
      const cur = plan.current;
      const physR = config.rmin / maxDim(curDims());
      const d = dimsOf(cur);
      applyStage(d, { init: plan.seeds[cur] ?? null, rmin: rminFor(d, physR) });
      plan.iterAccum[cur] = 0;
      beginStage(`Stage ${cur + 1} restarted from its ${plan.seeds[cur] ? 'refined' : 'uniform'} starting field.`);
    } finally {
      busy = false;
    }
  }

  /** Called when something outside the stage tab resets the solver (preset / grid / Reset). */
  function invalidate() {
    plan.auto = false;
    if (plan.current < 0 && !plan.results.length) return;
    plan.current = -1;
    plan.base = null;
    plan.results = [];
    plan.seeds = [];
    plan.iterAccum = [];
    plan.hist = [];
    plan.live = null;
    plan.note = 'Stage plan reset (grid, preset or solver was reset elsewhere).';
    render();
  }

  /* ------------------------------ live updates ------------------------------ */
  /** @param {{ kind: string, meta: Record<string, any> }} update */
  function onUpdate(update) {
    if (plan.current < 0 || busy || update.kind !== 'step' || update.meta?.error) return;
    const m = update.meta;
    plan.live = { iteration: m.iteration ?? 0, compliance: m.compliance ?? 0, vol: m.avgVolume ?? config.volfrac };
    plan.hist.push({ it: plan.live.iteration, c: plan.live.compliance });
    renderLive();

    if (!isRunning()) return;
    const stage = plan.stages[plan.current];
    const it = plan.live.iteration;
    const isLast = plan.current >= lastIndex();
    // Auto mode always has a cap and a convergence rule (coarse stages are looser).
    const cap = stage.maxIter > 0 ? stage.maxIter : plan.auto ? Math.round(numInput('stage-opt-auto-cap', 300)) : 0;
    let reason = '';
    if (cap > 0 && it >= cap) {
      reason = `reached ${cap} iterations`;
    } else if (
      (plan.auto || checked('stage-opt-autopause')) &&
      it >= (plan.auto ? (isLast ? AUTO_MIN_IT_FINAL : AUTO_MIN_IT_COARSE) : CONV_MIN_IT)
    ) {
      const old = [...plan.hist].reverse().find((h) => h.it <= it - CONV_WINDOW);
      if (old && old.c > 0) {
        const rel = (Math.abs(plan.live.compliance - old.c) / old.c) * 100;
        const tol = plan.auto
          ? isLast
            ? numInput('stage-opt-final-tol', 0.5)
            : numInput('stage-opt-coarse-tol', 3)
          : parseFloat($('stage-opt-tol')?.value ?? '1') || 1;
        if (rel < tol) reason = `ΔC ${rel.toFixed(2)}% over ${CONV_WINDOW} iterations`;
      }
    }
    if (!reason) return;
    setRunning(false);
    if (plan.auto && isLast) {
      const secs = ((performance.now() - plan.autoStartedAt) / 1000).toFixed(1);
      plan.auto = false;
      plan.note = `All ${plan.stages.length} stages complete (${reason}) in ${secs} s.`;
      render();
      return;
    }
    plan.note = `Paused: ${reason}.`;
    render();
    if ((plan.auto || checked('stage-opt-autoadvance')) && !isLast) void nextStage();
  }

  /* ------------------------------ rendering ------------------------------ */
  function stageStatus(i) {
    if (plan.current < 0) return 'pending';
    if (i < plan.current) return 'done';
    if (i === plan.current) return 'active';
    return 'pending';
  }

  function renderList() {
    const ul = $('stage-list');
    if (!ul) return;
    ul.innerHTML = plan.stages
      .map((s, i) => {
        const st = stageStatus(i);
        const d = dimsOf(i);
        const locked = st !== 'pending';
        const res = plan.results[i];
        const badge =
          st === 'active'
            ? '<span class="rounded bg-indigo-500/20 px-1 text-[9px] font-semibold uppercase text-indigo-200">active</span>'
            : st === 'done'
              ? '<span class="rounded bg-emerald-500/15 px-1 text-[9px] font-semibold uppercase text-emerald-300">done</span>'
              : '<span class="rounded bg-slate-700/60 px-1 text-[9px] font-semibold uppercase text-slate-400">pending</span>';
        const summary = res
          ? `<div class="mt-1 font-mono text-[10px] text-slate-400">${plan.iterAccum[i] ?? res.iteration} it · C ${res.compliance.toFixed(2)} · vol ${res.vol.toFixed(3)}</div>`
          : '';
        return `<li class="rounded-lg border p-1.5 ${st === 'active' ? 'border-indigo-500/50 bg-indigo-950/30' : 'border-slate-800 bg-slate-900/50'}">
          <div class="flex items-center justify-between text-[11px] text-slate-200">
            <span class="flex items-center gap-1.5">${badge} Stage ${i + 1}</span>
            <span class="font-mono text-[10px] text-slate-400">${d.nx}×${d.ny}×${d.nz} = ${fmt(d.total)}</span>
          </div>
          <div class="mt-1 grid grid-cols-[1fr_1fr_auto] items-end gap-1.5 text-[10px] text-slate-400">
            <label class="flex flex-col gap-0.5">Voxels (k)
              <input data-stage-target="${i}" type="number" min="1" max="${MAX_VOXELS / 1000}" step="1" value="${Math.round(s.target / 1000)}" ${locked ? 'disabled' : ''}
                class="rounded border border-slate-700 bg-slate-950 px-1 py-0.5 font-mono text-[11px] text-slate-200 disabled:opacity-50" />
            </label>
            <label class="flex flex-col gap-0.5">Max iter (0 = manual)
              <input data-stage-cap="${i}" type="number" min="0" max="2000" step="10" value="${s.maxIter}"
                class="rounded border border-slate-700 bg-slate-950 px-1 py-0.5 font-mono text-[11px] text-slate-200" />
            </label>
            <button type="button" data-stage-remove="${i}" ${plan.stages.length <= 1 || locked ? 'disabled' : ''} title="Remove stage"
              class="rounded border border-slate-700 px-1.5 py-0.5 text-[11px] text-rose-300 hover:bg-slate-800 disabled:opacity-30">✕</button>
          </div>${summary}
        </li>`;
      })
      .join('');
  }

  function renderLive() {
    const el = $('stage-live');
    if (!el) return;
    if (plan.current < 0) {
      el.innerHTML = `<span class="text-slate-500">Not started.</span> ${plan.note ? `<div class="mt-1 text-amber-300/90">${plan.note}</div>` : ''}`;
      return;
    }
    const d = { nx: config.nx, ny: config.ny, nz: config.nz };
    const live = plan.live;
    const total = plan.iterAccum.reduce((a, b) => a + (b ?? 0), 0) + (live?.iteration ?? 0);
    el.innerHTML = `<div class="flex items-center justify-between text-slate-300">
        <span>Stage <b>${plan.current + 1}</b>/${plan.stages.length}</span>
        <span class="font-mono text-[10px] text-indigo-300">${d.nx}×${d.ny}×${d.nz} · r<sub>min</sub> ${config.rmin.toFixed(1)}</span>
      </div>
      <div class="mt-1 grid grid-cols-3 gap-1 font-mono text-[11px]">
        <span>it <b class="text-slate-200">${live?.iteration ?? 0}</b></span>
        <span>C <b class="text-slate-200">${live ? live.compliance.toFixed(2) : '—'}</b></span>
        <span>V <b class="text-slate-200">${live ? live.vol.toFixed(3) : '—'}</b></span>
      </div>
      <div class="mt-1 text-[10px] text-slate-500">${total} iterations total</div>
      ${plan.note ? `<div class="mt-1 text-[10px] leading-snug text-amber-300/90">${plan.note}</div>` : ''}`;
  }

  function renderButtons() {
    const run = $('btn-stage-run');
    const started = plan.current >= 0;
    const running = isRunning();
    if (run) {
      run.classList.toggle('is-running', started && running);
      run.setAttribute('aria-pressed', String(started && running));
      const icon = run.querySelector('i');
      const label = run.querySelector('span');
      if (icon) icon.className = started && running ? 'ph-fill ph-pause text-sm' : 'ph-fill ph-play text-sm';
      if (label) {
        label.textContent = !started
          ? 'Start stage 1'
          : running
            ? `Pause stage ${plan.current + 1}`
            : `Resume stage ${plan.current + 1}`;
      }
    }
    const auto = $('btn-stage-auto');
    if (auto) {
      const autoOn = plan.auto && running;
      auto.classList.toggle('is-running', autoOn);
      auto.setAttribute('aria-pressed', String(autoOn));
      const icon = auto.querySelector('i');
      const label = auto.querySelector('span');
      if (icon) icon.className = autoOn ? 'ph-fill ph-pause text-sm' : 'ph-fill ph-rocket-launch text-sm';
      if (label) {
        label.textContent = autoOn
          ? `Pause auto run (stage ${plan.current + 1}/${plan.stages.length})`
          : plan.auto && started
            ? 'Resume auto run'
            : started
              ? 'Run remaining stages (auto)'
              : 'Run all stages (auto)';
      }
    }
    const set = (id, disabled) => {
      const b = $(id);
      if (b) b.disabled = disabled;
    };
    set('btn-stage-next', !started || plan.current >= lastIndex());
    set('btn-stage-prev', !started || plan.current <= 0);
    set('btn-stage-redo', !started);
    set('btn-stage-restart', !started);
    const nextBtn = $('btn-stage-next');
    if (nextBtn && started && plan.current < lastIndex()) {
      const d = dimsOf(plan.current + 1);
      nextBtn.title = `Pause, interpolate onto ${d.nx}×${d.ny}×${d.nz} (${fmt(d.total)}) and continue`;
    }
  }

  function renderAspect() {
    const el = $('stage-aspect');
    if (!el) return;
    const b = baseDims();
    el.textContent = `aspect ${b.nx}:${b.ny}:${b.nz}`;
  }

  function render() {
    renderAspect();
    renderList();
    renderLive();
    renderButtons();
  }

  /* ------------------------------ events ------------------------------ */
  on($('btn-stage-run'), 'click', () => {
    plan.auto = false;
    if (plan.current < 0) void start();
    else setRunning(!isRunning());
  });
  on($('btn-stage-auto'), 'click', () => void startAuto());
  on($('btn-stage-next'), 'click', () => {
    plan.auto = false;
    void nextStage();
  });
  on($('btn-stage-prev'), 'click', () => {
    plan.auto = false;
    void prevStage();
  });
  on($('btn-stage-redo'), 'click', () => {
    plan.auto = false;
    void redoStage();
  });
  on($('btn-stage-restart'), 'click', () => {
    plan.auto = false;
    void start();
  });

  on($('btn-stage-add'), 'click', () => {
    const last = plan.stages[plan.stages.length - 1];
    plan.stages.push({ target: Math.min(MAX_VOXELS, Math.round((last?.target ?? 24_000) * 2)), maxIter: 0 });
    render();
  });

  on($('stage-list'), 'click', (e) => {
    const rm = e.target.closest('[data-stage-remove]');
    if (!rm || rm.disabled) return;
    const i = Number(rm.dataset.stageRemove);
    if (plan.stages.length > 1 && stageStatus(i) === 'pending') {
      plan.stages.splice(i, 1);
      render();
    }
  });

  on($('stage-list'), 'change', (e) => {
    const t = /** @type {HTMLInputElement} */ (e.target);
    const v = parseFloat(t.value);
    if (!Number.isFinite(v)) return;
    if (t.dataset.stageTarget !== undefined) {
      plan.stages[Number(t.dataset.stageTarget)].target = Math.min(MAX_VOXELS, Math.max(1000, Math.round(v * 1000)));
    } else if (t.dataset.stageCap !== undefined) {
      plan.stages[Number(t.dataset.stageCap)].maxIter = Math.max(0, Math.round(v));
    }
    render();
  });

  on($('stage-opt-sharpen'), 'input', (e) => {
    const el = $('val-stage-sharpen');
    if (el) el.textContent = parseFloat(e.target.value).toFixed(2);
  });

  render();

  return {
    onUpdate,
    invalidate,
    /** Refresh run/pause label + aspect (call when run state or grid changes). */
    sync: () => {
      renderButtons();
      if (plan.current < 0) {
        renderAspect();
        renderList();
      }
    },
    isActive: () => plan.current >= 0,
    getPlan: () => plan,
    dispose: () => ac.abort(),
  };
}
