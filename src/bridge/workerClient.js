import { RESET, STEP, RUN, PAUSE, ACK, UPDATE_PARAMS, STATE_UPDATE } from '../worker/protocol.js';

/**
 * @typedef {Object} StateUpdate
 * @property {'reset'|'step'} kind        What request this reply answers.
 * @property {Record<string, any>} meta   Worker meta (iteration, compliance, timings, backend, …).
 * @property {Float32Array} densities
 * @property {Float32Array} energies
 * @property {Float32Array} dispY
 * @property {number} roundTripMs         Main-thread latency from post (or previous reply, in run mode) to reply.
 */

/**
 * Main-thread facade over the topology worker.
 *
 * Semantics:
 *  - `busy`: a RESET/STEP/RUN is in flight; further STEP requests are dropped.
 *  - `pendingReset`: a RESET requested while busy is deferred (latest payload wins)
 *    and dispatched as soon as the in-flight request has finished. A RESET requested
 *    while a run is active also pauses that run.
 *  - while `running`, the worker iterates autonomously (RUN). It streams STATE_UPDATEs
 *    without waiting for the main thread (the GPU never idles on message latency) and
 *    the main thread ACKs each one for back-pressure. PAUSE ends the run with a final
 *    reply (`meta.runEnded`), after which `busy` clears.
 */
export class WorkerClient {
  /** @param {(update: StateUpdate) => void} onStateUpdate */
  constructor(onStateUpdate) {
    this.onStateUpdate = onStateUpdate;
    /** @type {Worker | null} */
    this.worker = null;
    this.busy = false;
    /** @type {Record<string, any> | null} */
    this.pendingReset = null;
    this.running = false;
    this.batchSize = 1;
    /** @type {((err: unknown) => void) | null} */
    this.onError = null;

    /** @type {'reset'|'step'|'run'|null} */
    this._inFlight = null;
    this._sentAt = 0;
    this._runId = 0;
    this._pauseSent = false;
  }

  start() {
    this.terminate();
    this.worker = new Worker(new URL('../worker/topoWorker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => this._handleMessage(e);
    this.worker.onerror = (e) => {
      console.error('[WorkerClient] worker error', e.message || e);
      this.busy = false;
      this._inFlight = null;
      this.running = false;
      this.onError?.(e);
    };
    return this;
  }

  /**
   * Re-initialise the solver. Deferred while a request is in flight.
   * @param {{ nx: number, ny: number, nz: number, volfrac: number, penal: number, rmin: number, scene?: import('../scene/types.js').Scene | null }} payload
   */
  reset(payload) {
    if (!this.worker) return false;
    if (this.busy) {
      this.pendingReset = { ...payload };
      this._pauseRun();
      return false;
    }
    this.pendingReset = null;
    this._post(RESET, { ...payload }, 'reset');
    return true;
  }

  /**
   * Request `batch` SIMP iterations. Dropped if the worker is busy.
   * @param {number} [batch]
   */
  step(batch = this.batchSize) {
    if (!this.worker || this.busy) return false;
    this.batchSize = batch;
    this._post(STEP, { batch }, 'step');
    return true;
  }

  /**
   * Push runtime parameter changes (volfrac / penal / rmin). Safe while busy:
   * the worker applies them before the next iteration is submitted, and a deferred
   * reset is patched so it does not overwrite the new values.
   * @param {{ volfrac?: number, penal?: number, rmin?: number }} payload
   */
  updateParams(payload) {
    if (!this.worker) return;
    if (this.pendingReset) Object.assign(this.pendingReset, payload);
    this.worker.postMessage({ type: UPDATE_PARAMS, payload });
  }

  /**
   * Enable/disable continuous optimisation.
   * @param {boolean} run
   */
  setRunning(run) {
    this.running = !!run;
    if (this.running) this._startRun();
    else this._pauseRun();
  }

  terminate() {
    if (this.worker) {
      this.worker.onmessage = null;
      this.worker.onerror = null;
      this.worker.terminate();
      this.worker = null;
    }
    this.busy = false;
    this.pendingReset = null;
    this._inFlight = null;
    this._pauseSent = false;
  }

  /** @private */
  _startRun() {
    if (!this.worker || this.busy) return false;
    this._runId += 1;
    this._pauseSent = false;
    this._post(RUN, { runId: this._runId }, 'run');
    return true;
  }

  /** @private */
  _pauseRun() {
    if (!this.worker || this._inFlight !== 'run' || this._pauseSent) return;
    this._pauseSent = true;
    this.worker.postMessage({ type: PAUSE, payload: { runId: this._runId } });
  }

  /** @private */
  _post(type, payload, kind) {
    this.busy = true;
    this._inFlight = kind;
    this._sentAt = performance.now();
    this.worker.postMessage({ type, payload });
  }

  /** @private */
  _handleMessage(e) {
    const { type, meta, densities, energies, dispY } = e.data;
    if (type !== STATE_UPDATE) return;

    const inRun = this._inFlight === 'run';
    const ended = !inRun || !!meta?.runEnded || !!meta?.error;
    const kind = inRun ? 'step' : (this._inFlight ?? 'step');
    const now = performance.now();
    const roundTripMs = now - this._sentAt;
    this._sentAt = now;

    if (ended) {
      this.busy = false;
      this._inFlight = null;
      this._pauseSent = false;
    }

    try {
      this.onStateUpdate?.({
        kind,
        meta: meta ?? {},
        densities: new Float32Array(densities),
        energies: new Float32Array(energies),
        dispY: new Float32Array(dispY),
        roundTripMs,
      });
    } catch (err) {
      console.error('[WorkerClient] onStateUpdate failed', err);
    }

    if (!ended) {
      // Mid-run reply consumed (UI redraw done): let the worker post the next one.
      this.worker?.postMessage({ type: ACK });
      return;
    }

    if (meta?.error) this.running = false;

    if (this.pendingReset) {
      const next = this.pendingReset;
      this.pendingReset = null;
      this.reset(next);
    } else if (this.running) {
      this._startRun();
    }
  }
}
