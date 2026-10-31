import { FEA_CONSTANTS } from '../../config/defaults.js';
import { KE_24x24 } from '../../fea/hex8Ke.js';
import { applyBCs } from '../../presets/boundaryConditions.js';
import { buildPassiveMask } from '../../scene/passiveVoids.js';
import { getGpuContext } from './context.js';

const { Emin, E0, maxIters: DEFAULT_MAX_ITERS, cgTol, moveLimit } = FEA_CONSTANTS;

const WG = 256;
const PARAMS_BYTES = 48;
const KE_BYTES = 144 * 16;
const SCALARS_COUNT = 8;
const OC_COUNT = 8;
const SLOT_RZ = 0;
const SLOT_PAP = 1;
const SLOT_RZ_NEW = 4;
const SLOT_RES2 = 5;
const OC_VOLUME = 4;
const OC_COMPLIANCE = 5;

const XMIN = 0.001;
/** Log-space bisection on the OC multiplier: ln-range 64 / 2^32 ≈ 1.5e-8. */
const OC_BISECT_STEPS = 32;

/** GPU path: run fixed iterations (no early exit) so the device stays saturated. */
const GPU_FIXED_ITERS = 80;

const ENTRY_POINTS = [
  'spmv_gather',
  'build_invdiag',
  'jacobi_apply',
  'saxpy',
  'saxpy_neg',
  'xpay',
  'scale_copy',
  'residual_init',
  'reduce_dot',
  'final_reduce',
  'pcg_set_alpha',
  'pcg_set_beta',
  'pcg_seed_alpha_one',
  'element_energy',
];

const SIMP_ENTRY_POINTS = [
  'filter_dc',
  'oc_init',
  'oc_candidate_sum',
  'oc_bisect_step',
  'oc_apply',
  'finalize_volume',
  'energy_sum',
  'finalize_compliance',
  'disp_y',
];

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * Matrix-free Jacobi-PCG on WebGPU, plus a fully GPU-resident SIMP update.
 *
 * `simpSubmit` / `simpCollect` run FEA → sensitivity filter → OC bisection → density
 * update in a single command buffer. Densities and displacements never leave the
 * device between iterations, and two iterations can be queued back-to-back so the
 * GPU is not waiting on CPU post-processing or main-thread latency.
 */
export class GpuPcgSolver {
  /**
   * @param {{
   *   shaderSource?: string,
   *   shaderUrl?: string | URL,
   *   simpShaderSource?: string,
   *   simpShaderUrl?: string | URL,
   *   context?: import('./context.js').GpuContext,
   *   fixedIters?: number,
   * }} [options]
   */
  constructor(options = {}) {
    this.backend = 'webgpu';
    this._shaderSource = options.shaderSource ?? null;
    this._shaderUrl = options.shaderUrl ?? new URL('./shaders/kernels.wgsl', import.meta.url);
    this._simpShaderSource = options.simpShaderSource ?? null;
    this._simpShaderUrl = options.simpShaderUrl ?? new URL('./shaders/simp.wgsl', import.meta.url);
    this._ctxOverride = options.context ?? null;
    this._fixedIters = options.fixedIters ?? GPU_FIXED_ITERS;

    this._ready = false;
    this._lost = null;
    this._gpuError = null;
    this.device = null;
    this.queue = null;
    this.pipelines = {};
    this._dims = null;
    this._buf = null;
    this._bg = null;
    this._bcKey = null;
    this._passiveKey = null;
    this._hasPassive = false;
    this._fixedDofs = null;
    this._keRef = null;
    this._feaPenal = null;
    this._owner = null;
    this._ownerVersion = -1;
    this._uDirty = true;
    this._tickets = 0;
    this._lastDone = 0;
    this._simpView = new DataView(new ArrayBuffer(PARAMS_BYTES));
  }

  getName() {
    return 'webgpu';
  }

  async init() {
    if (this._ready) return true;

    const ctx = this._ctxOverride ?? (await getGpuContext());
    if (!ctx) throw new Error('WebGPU is not available');
    const { device } = ctx;
    this.device = device;
    this.queue = device.queue;

    const code = this._shaderSource ?? (await this._loadShader(this._shaderUrl, 'kernels.wgsl'));
    const simpCode =
      this._simpShaderSource ?? (await this._loadShader(this._simpShaderUrl, 'simp.wgsl'));

    device.pushErrorScope('validation');
    let scopeError = null;
    try {
      const build = async (src, entries, label) => {
        const module = device.createShaderModule({ code: src });
        if (typeof module.getCompilationInfo === 'function') {
          const info = await module.getCompilationInfo();
          const errs = info.messages.filter((m) => m.type === 'error');
          if (errs.length) {
            throw new Error(
              `WGSL compile failed (${label}): ` +
                errs.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join('; '),
            );
          }
        }
        for (const entryPoint of entries) {
          this.pipelines[entryPoint] = device.createComputePipeline({
            layout: 'auto',
            compute: { module, entryPoint },
          });
        }
      };
      await build(code, ENTRY_POINTS, 'kernels');
      await build(simpCode, SIMP_ENTRY_POINTS, 'simp');
    } finally {
      scopeError = await device.popErrorScope();
    }
    if (scopeError) throw new Error(`WebGPU pipeline creation failed: ${scopeError.message}`);

    this._keBuf = device.createBuffer({
      size: KE_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this._keRef = null;

    device.lost.then((info) => {
      this._lost = info;
      this._ready = false;
    });
    // Async-submitted work cannot be wrapped in an error scope without a sync point.
    device.addEventListener?.('uncapturederror', (ev) => {
      this._gpuError = ev?.error?.message ?? 'unknown WebGPU error';
      ev?.preventDefault?.();
    });

    this._ready = true;
    return true;
  }

  async _loadShader(url, name) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to load ${name} (${res.status})`);
    return res.text();
  }

  dispose() {
    this._destroyBuffers();
    this._keBuf?.destroy();
    this._keBuf = null;
    this._ready = false;
  }

  _destroyBuffers() {
    if (this._buf) {
      for (const b of Object.values(this._buf)) b.destroy();
    }
    this._buf = null;
    this._bg = null;
    this._dims = null;
    this._bcKey = null;
    this._passiveKey = null;
    this._feaPenal = null;
    this._owner = null;
    this._ownerVersion = -1;
    this._uDirty = true;
  }

  _ensureBuffers(nx, ny, nz) {
    const dims = `${nx}x${ny}x${nz}`;
    if (this._dims === dims && this._buf) return;
    this._destroyBuffers();

    const { device } = this;
    const nNodes = (nx + 1) * (ny + 1) * (nz + 1);
    const nDofs = 3 * nNodes;
    const nElements = nx * ny * nz;
    const nWG = Math.ceil(nDofs / WG);
    const nElemWG = Math.ceil(nElements / WG);

    const maxWG = device.limits.maxComputeWorkgroupsPerDimension;
    if (nWG > maxWG) throw new Error(`Grid too large (${nWG} > ${maxWG} workgroups)`);

    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
    const UNI = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;
    const MAP = GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST;
    const mk = (bytes, usage = S) => device.createBuffer({ size: Math.max(16, bytes), usage });
    const vec = () => mk(nDofs * 4);
    // Element buffers sized to max(nDofs, nElements) so they can hold energies/dc
    const elemBytes = Math.max(nDofs, nElements) * 4;

    const buf = {
      xPhys: mk(nElements * 4),
      fixed: mk(nDofs * 4),
      invDiag: vec(),
      U: vec(),
      r: vec(),
      z: vec(),
      p: vec(),
      Ap: vec(),
      F: vec(),
      energy: mk(elemBytes),
      dc: mk(elemBytes),
      dcf: mk(nElements * 4),
      passive: mk(nElements * 4),
      dispY: mk(nElements * 4),
      partials: mk(nWG * 4),
      scalars: mk(SCALARS_COUNT * 4),
      oc: mk(OC_COUNT * 4),
      pRZ: mk(PARAMS_BYTES, UNI),
      pPAP: mk(PARAMS_BYTES, UNI),
      pRZnew: mk(PARAMS_BYTES, UNI),
      pSimp: mk(PARAMS_BYTES, UNI),
    };
    // Two staging sets: ticket k+1 can be in flight while ticket k is being read.
    for (let s = 0; s < 2; s++) {
      buf[`stgX${s}`] = mk(nElements * 4, MAP);
      buf[`stgE${s}`] = mk(nElements * 4, MAP);
      buf[`stgD${s}`] = mk(nElements * 4, MAP);
      buf[`stgOc${s}`] = mk(OC_COUNT * 4, MAP);
      buf[`stgSc${s}`] = mk(SCALARS_COUNT * 4, MAP);
    }

    const KEB = this._keBuf;
    const e = (binding, buffer) => ({ binding, resource: { buffer } });
    const group = (entry, entries) =>
      device.createBindGroup({
        layout: this.pipelines[entry].getBindGroupLayout(0),
        entries,
      });
    const withS = (entries) => [...entries, e(9, buf.scalars)];
    const P = buf.pRZ;

    this._bg = {
      invDiag: group('build_invdiag', [e(0, P), e(1, KEB), e(2, buf.xPhys), e(3, buf.fixed), e(4, buf.invDiag)]),
      spmvU: group('spmv_gather', [e(0, P), e(1, KEB), e(2, buf.xPhys), e(3, buf.fixed), e(5, buf.U), e(6, buf.Ap)]),
      spmvP: group('spmv_gather', [e(0, P), e(1, KEB), e(2, buf.xPhys), e(3, buf.fixed), e(5, buf.p), e(6, buf.Ap)]),
      residual: group('residual_init', [e(0, P), e(3, buf.fixed), e(5, buf.F), e(6, buf.Ap), e(7, buf.r)]),
      jacobi: group('jacobi_apply', [e(0, P), e(3, buf.fixed), e(4, buf.invDiag), e(5, buf.r), e(6, buf.z)]),
      copyZP: group('scale_copy', withS([e(0, P), e(5, buf.z), e(6, buf.p)])),
      xpay: group('xpay', withS([e(0, P), e(5, buf.z), e(6, buf.p)])),
      saxpyU: group('saxpy', withS([e(0, P), e(5, buf.p), e(6, buf.U)])),
      saxpyNegR: group('saxpy_neg', withS([e(0, P), e(5, buf.Ap), e(6, buf.r)])),
      dotRZ: group('reduce_dot', [e(0, buf.pRZ), e(5, buf.r), e(6, buf.z), e(8, buf.partials)]),
      dotPAp: group('reduce_dot', [e(0, buf.pPAP), e(5, buf.p), e(6, buf.Ap), e(8, buf.partials)]),
      dotRZnew: group('reduce_dot', [e(0, buf.pRZnew), e(5, buf.r), e(6, buf.z), e(8, buf.partials)]),
      finalRZ: group('final_reduce', [e(0, buf.pRZ), e(8, buf.partials), e(9, buf.scalars)]),
      finalPAP: group('final_reduce', [e(0, buf.pPAP), e(8, buf.partials), e(9, buf.scalars)]),
      finalRZnew: group('final_reduce', [e(0, buf.pRZnew), e(8, buf.partials), e(9, buf.scalars)]),
      setAlpha: group('pcg_set_alpha', [e(9, buf.scalars)]),
      setBeta: group('pcg_set_beta', [e(9, buf.scalars)]),
      seedAlpha: group('pcg_seed_alpha_one', [e(9, buf.scalars)]),
      energy: group('element_energy', [
        e(0, P), e(1, KEB), e(2, buf.xPhys), e(3, buf.fixed), e(5, buf.U), e(6, buf.energy), e(7, buf.dc),
      ]),
      // --- SIMP update ---
      filter: group('filter_dc', [e(0, buf.pSimp), e(1, buf.xPhys), e(2, buf.dc), e(3, buf.dcf)]),
      ocInit: group('oc_init', [e(6, buf.oc)]),
      ocCand: group('oc_candidate_sum', [
        e(0, buf.pSimp), e(1, buf.xPhys), e(3, buf.dcf), e(4, buf.passive), e(5, buf.partials), e(6, buf.oc),
      ]),
      ocBisect: group('oc_bisect_step', [e(0, buf.pSimp), e(5, buf.partials), e(6, buf.oc)]),
      ocApply: group('oc_apply', [
        e(0, buf.pSimp), e(1, buf.xPhys), e(3, buf.dcf), e(4, buf.passive), e(5, buf.partials), e(6, buf.oc),
      ]),
      finalVol: group('finalize_volume', [e(0, buf.pSimp), e(5, buf.partials), e(6, buf.oc)]),
      energySum: group('energy_sum', [e(0, buf.pSimp), e(5, buf.partials), e(7, buf.energy)]),
      finalCompl: group('finalize_compliance', [e(0, buf.pSimp), e(5, buf.partials), e(6, buf.oc)]),
      dispY: group('disp_y', [e(0, buf.pSimp), e(8, buf.U), e(9, buf.dispY)]),
    };

    this._buf = buf;
    this._dims = dims;
    this._nx = nx;
    this._ny = ny;
    this._nz = nz;
    this._nDofs = nDofs;
    this._nElements = nElements;
    this._nWG = nWG;
    this._nElemWG = nElemWG;
  }

  /** FEA params (penal) → the three uniform buffers that differ only by reduce slot. */
  _ensureFeaParams(penal) {
    if (this._feaPenal === penal) return;
    const v = new DataView(new ArrayBuffer(PARAMS_BYTES));
    const write = (buffer, slot) => {
      v.setUint32(0, this._nx, true);
      v.setUint32(4, this._ny, true);
      v.setUint32(8, this._nz, true);
      v.setUint32(12, this._nDofs, true);
      v.setUint32(16, this._nElements, true);
      v.setFloat32(20, penal, true);
      v.setFloat32(24, Emin, true);
      v.setFloat32(28, E0, true);
      v.setFloat32(32, 0, true);
      v.setFloat32(36, 0, true);
      v.setUint32(40, slot, true);
      v.setUint32(44, this._nWG, true);
      this.queue.writeBuffer(buffer, 0, v.buffer.slice(0));
    };
    write(this._buf.pRZ, SLOT_RZ);
    write(this._buf.pPAP, SLOT_PAP);
    write(this._buf.pRZnew, SLOT_RZ_NEW);
    this._feaPenal = penal;
  }

  _writeSimpParams({ rmin, volfrac }) {
    const v = this._simpView;
    v.setUint32(0, this._nx, true);
    v.setUint32(4, this._ny, true);
    v.setUint32(8, this._nz, true);
    v.setUint32(12, this._nElements, true);
    v.setFloat32(16, rmin, true);
    v.setUint32(20, Math.max(1, Math.ceil(rmin)), true);
    v.setFloat32(24, moveLimit, true);
    v.setFloat32(28, XMIN, true);
    v.setFloat32(32, volfrac * this._nElements, true);
    v.setUint32(36, this._nElemWG, true);
    v.setUint32(40, this._hasPassive ? 1 : 0, true);
    v.setUint32(44, 0, true);
    this.queue.writeBuffer(this._buf.pSimp, 0, v.buffer.slice(0));
  }

  _ensureConstants({ nx, ny, nz, preset, scene = null, KE }) {
    if (KE.length !== 576) throw new Error('KE must be a 24x24 Float32Array');
    if (this._keRef !== KE) {
      this.queue.writeBuffer(this._keBuf, 0, KE instanceof Float32Array ? KE : new Float32Array(KE));
      this._keRef = KE;
    }

    const sceneKey = preset === 'custom' ? `:${JSON.stringify(scene)}` : '';
    const key = `${nx}x${ny}x${nz}:${preset}${sceneKey}`;
    if (this._bcKey === key) return;
    const nDofs = this._nDofs;
    const fixedDofs = new Uint8Array(nDofs);
    const F = new Float32Array(nDofs);
    applyBCs(fixedDofs, F, nx, ny, nz, preset, scene);
    const mask = new Uint32Array(nDofs);
    for (let i = 0; i < nDofs; i++) mask[i] = fixedDofs[i];
    this.queue.writeBuffer(this._buf.fixed, 0, mask);
    this.queue.writeBuffer(this._buf.F, 0, F);
    this._fixedDofs = fixedDofs;
    this._bcKey = key;
    this._uDirty = true;

    // Passive (void / locked-solid) mask is a pure function of the scene: build once.
    const nElements = this._nElements;
    const pass = new Uint32Array(nElements);
    let any = false;
    if (preset === 'custom' && scene) {
      const m = buildPassiveMask(nx, ny, nz, scene);
      if (m) {
        for (let i = 0; i < nElements; i++) {
          pass[i] = m[i];
          if (m[i]) any = true;
        }
      }
    }
    this._hasPassive = any;
    this.queue.writeBuffer(this._buf.passive, 0, pass);
  }

  _dispatch(pass, entry, bindGroup, workgroups) {
    pass.setPipeline(this.pipelines[entry]);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(workgroups ?? Math.ceil(this._nDofs / WG));
  }

  /** Whole Jacobi-PCG solve for K U = F at the current xPhys / U (warm start). */
  _encodeFea(enc) {
    const bg = this._bg;
    const iters = this._fixedIters || DEFAULT_MAX_ITERS;
    {
      const pass = enc.beginComputePass();
      this._dispatch(pass, 'build_invdiag', bg.invDiag);
      this._dispatch(pass, 'spmv_gather', bg.spmvU);
      this._dispatch(pass, 'residual_init', bg.residual);
      this._dispatch(pass, 'jacobi_apply', bg.jacobi);
      this._dispatch(pass, 'pcg_seed_alpha_one', bg.seedAlpha, 1);
      this._dispatch(pass, 'scale_copy', bg.copyZP);
      this._dispatch(pass, 'reduce_dot', bg.dotRZ);
      this._dispatch(pass, 'final_reduce', bg.finalRZ, 1);
      pass.end();
    }

    for (let it = 0; it < iters; it++) {
      const pass = enc.beginComputePass();
      if (it > 0) this._dispatch(pass, 'xpay', bg.xpay);
      this._dispatch(pass, 'spmv_gather', bg.spmvP);
      this._dispatch(pass, 'reduce_dot', bg.dotPAp);
      this._dispatch(pass, 'final_reduce', bg.finalPAP, 1);
      this._dispatch(pass, 'pcg_set_alpha', bg.setAlpha, 1);
      this._dispatch(pass, 'saxpy', bg.saxpyU);
      this._dispatch(pass, 'saxpy_neg', bg.saxpyNegR);
      this._dispatch(pass, 'jacobi_apply', bg.jacobi);
      this._dispatch(pass, 'reduce_dot', bg.dotRZnew);
      this._dispatch(pass, 'final_reduce', bg.finalRZnew, 1);
      this._dispatch(pass, 'pcg_set_beta', bg.setBeta, 1);
      pass.end();
    }

    const pass = enc.beginComputePass();
    this._dispatch(pass, 'element_energy', bg.energy, this._nElemWG);
    pass.end();
  }

  /** Sensitivity filter → OC bisection → in-place density update → reductions. */
  _encodeSimp(enc) {
    const bg = this._bg;
    const nEW = this._nElemWG;
    const pass = enc.beginComputePass();
    this._dispatch(pass, 'filter_dc', bg.filter, Math.ceil(this._nElements / 128));
    this._dispatch(pass, 'energy_sum', bg.energySum, nEW);
    this._dispatch(pass, 'finalize_compliance', bg.finalCompl, 1);
    this._dispatch(pass, 'disp_y', bg.dispY, nEW);
    this._dispatch(pass, 'oc_init', bg.ocInit, 1);
    for (let b = 0; b < OC_BISECT_STEPS; b++) {
      this._dispatch(pass, 'oc_candidate_sum', bg.ocCand, nEW);
      this._dispatch(pass, 'oc_bisect_step', bg.ocBisect, 1);
    }
    this._dispatch(pass, 'oc_apply', bg.ocApply, nEW);
    this._dispatch(pass, 'finalize_volume', bg.finalVol, 1);
    pass.end();
  }

  async _mapRead(staging, byteLength, into) {
    await staging.mapAsync(GPUMapMode.READ, 0, byteLength);
    into.set(new Float32Array(staging.getMappedRange(0, byteLength)));
    staging.unmap();
  }

  // ---------------------------------------------------------------------------
  // GPU-resident SIMP iteration (pipelined)
  // ---------------------------------------------------------------------------

  /**
   * Make the device copy of densities match `state`, zero the warm-start U if needed.
   * Densities live on the GPU between iterations; the CPU copy is only a mirror.
   */
  _syncState(state) {
    const { queue, _buf: buf } = this;
    const version = state.xVersion | 0;
    if (this._owner !== state || this._ownerVersion !== version) {
      queue.writeBuffer(buf.xPhys, 0, state.xPhys);
      this._owner = state;
      this._ownerVersion = version;
      this._uDirty = true;
    }
    if (this._uDirty) {
      queue.writeBuffer(buf.U, 0, new Float32Array(this._nDofs));
      this._uDirty = false;
    }
  }

  /**
   * Encode + submit one full SIMP iteration. Does not wait for the GPU.
   * @param {import('../../topo/solverState.js').SolverState} state
   * @returns {{ parity: number, submittedAt: number }}
   */
  simpSubmit(state) {
    if (!this._ready) {
      throw new Error(this._lost ? `WebGPU device lost: ${this._lost.message}` : 'GpuPcgSolver not initialised');
    }
    const { nx, ny, nz } = state;
    if (state.xPhys.length !== nx * ny * nz) throw new Error('xPhys length does not match grid');

    this._ensureBuffers(nx, ny, nz);
    this._ensureConstants({
      nx, ny, nz, preset: state.preset, scene: state.scene ?? null, KE: state.KE ?? KE_24x24,
    });
    this._ensureFeaParams(state.penal);
    this._syncState(state);
    this._writeSimpParams({ rmin: state.rmin, volfrac: state.volfrac });

    const { device, queue, _buf: buf } = this;
    const parity = this._tickets++ & 1;
    queue.writeBuffer(buf.scalars, 0, new Float32Array(SCALARS_COUNT));

    const enc = device.createCommandEncoder();
    this._encodeFea(enc);
    this._encodeSimp(enc);
    const n = this._nElements * 4;
    enc.copyBufferToBuffer(buf.xPhys, 0, buf[`stgX${parity}`], 0, n);
    enc.copyBufferToBuffer(buf.energy, 0, buf[`stgE${parity}`], 0, n);
    enc.copyBufferToBuffer(buf.dispY, 0, buf[`stgD${parity}`], 0, n);
    enc.copyBufferToBuffer(buf.oc, 0, buf[`stgOc${parity}`], 0, OC_COUNT * 4);
    enc.copyBufferToBuffer(buf.scalars, 0, buf[`stgSc${parity}`], 0, SCALARS_COUNT * 4);
    queue.submit([enc.finish()]);

    return { parity, submittedAt: now(), owner: state, version: this._ownerVersion };
  }

  /**
   * Wait for a submitted iteration and mirror its result into `state`.
   * @param {{ parity: number, submittedAt: number }} ticket
   * @param {import('../../topo/solverState.js').SolverState} state
   */
  async simpCollect(ticket, state) {
    const buf = this._buf;
    if (!buf || !this._ready) {
      throw new Error(this._lost ? `WebGPU device lost: ${this._lost.message}` : 'GPU buffers released');
    }
    const p = ticket.parity;
    const n = this._nElements;
    const oc = new Float32Array(OC_COUNT);
    const sc = new Float32Array(SCALARS_COUNT);
    if (!state.dispY || state.dispY.length !== n) state.dispY = new Float32Array(n);

    const mapInto = async (staging, bytes, apply) => {
      await staging.mapAsync(GPUMapMode.READ, 0, bytes);
      apply(new Float32Array(staging.getMappedRange(0, bytes)));
      staging.unmap();
    };

    // Map in submission order; results land only after the iteration finished.
    await mapInto(buf[`stgOc${p}`], OC_COUNT * 4, (v) => oc.set(v));
    const doneAt = now();
    await Promise.all([
      mapInto(buf[`stgX${p}`], n * 4, (v) => {
        state.xPhys.set(v);
        state.x.set(v);
      }),
      mapInto(buf[`stgE${p}`], n * 4, (v) => state.elementEnergies.set(v)),
      mapInto(buf[`stgD${p}`], n * 4, (v) => state.dispY.set(v)),
      mapInto(buf[`stgSc${p}`], SCALARS_COUNT * 4, (v) => sc.set(v)),
    ]);
    if (this._gpuError) {
      const msg = this._gpuError;
      this._gpuError = null;
      throw new Error(`WebGPU error: ${msg}`);
    }

    let maxDisp = 0;
    const d = state.dispY;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(d[i]);
      if (a > maxDisp) maxDisp = a;
    }

    // GPU-busy time for this iteration: from when it could start to when it finished.
    const gpuMs = Math.max(0, doneAt - Math.max(ticket.submittedAt, this._lastDone));
    this._lastDone = doneAt;
    const cpuMs = now() - doneAt;

    state.iteration += 1;
    const res2 = sc[SLOT_RES2] || sc[SLOT_RZ];
    return {
      iteration: state.iteration,
      compliance: oc[OC_COMPLIANCE],
      cgResidual: Math.sqrt(Math.max(0, res2)) || cgTol,
      maxDisp,
      avgVolume: oc[OC_VOLUME],
      timings: { feaMs: gpuMs, filterOcMs: cpuMs },
    };
  }

  // ---------------------------------------------------------------------------
  // Stand-alone FEA solve (used by benches / fallback paths)
  // ---------------------------------------------------------------------------

  /**
   * @param {{
   *   nx: number, ny: number, nz: number, penal: number, preset: string,
   *   scene?: import('../../scene/types.js').Scene | null,
   *   xPhys: Float32Array, globalU?: Float32Array | null, KE?: Float32Array,
   *   elementEnergies?: Float32Array,
   * }} params
   */
  async solve(params) {
    if (!this._ready) {
      throw new Error(this._lost ? `WebGPU device lost: ${this._lost.message}` : 'GpuPcgSolver not initialised');
    }
    const t0 = now();
    const { device } = this;

    device.pushErrorScope('validation');
    let result;
    let failure = null;
    try {
      result = await this._solveInner(params);
    } catch (err) {
      failure = err;
    }
    const gpuError = await device.popErrorScope();
    if (failure) throw failure;
    if (gpuError) throw new Error(`WebGPU validation error: ${gpuError.message}`);

    return { ...result, backend: 'webgpu', feaMs: now() - t0 };
  }

  async _solveInner({
    nx, ny, nz, penal, preset, scene = null, xPhys, globalU, KE = KE_24x24, elementEnergies,
  }) {
    const nDofs = 3 * (nx + 1) * (ny + 1) * (nz + 1);
    const nElements = nx * ny * nz;
    if (xPhys.length !== nElements) throw new Error('xPhys length does not match grid');

    this._ensureBuffers(nx, ny, nz);
    this._ensureConstants({ nx, ny, nz, preset, scene, KE });
    this._ensureFeaParams(penal);
    const fixedDofs = this._fixedDofs;
    const { device, queue, _buf: buf } = this;

    // The caller owns xPhys here, so the resident SIMP copy is no longer authoritative.
    this._owner = null;
    queue.writeBuffer(buf.xPhys, 0, xPhys instanceof Float32Array ? xPhys : new Float32Array(xPhys));
    const U0 = new Float32Array(nDofs);
    if (globalU && globalU.length === nDofs) U0.set(globalU);
    for (let i = 0; i < nDofs; i++) if (fixedDofs[i]) U0[i] = 0;
    queue.writeBuffer(buf.U, 0, U0);
    queue.writeBuffer(buf.scalars, 0, new Float32Array(SCALARS_COUNT));

    const mapBuf = (bytes) =>
      device.createBuffer({ size: Math.max(16, bytes), usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const stU = mapBuf(nDofs * 4);
    const stE = mapBuf(nElements * 4);
    const stDc = mapBuf(nElements * 4);
    const stSc = mapBuf(SCALARS_COUNT * 4);

    const enc = device.createCommandEncoder();
    this._encodeFea(enc);
    enc.copyBufferToBuffer(buf.U, 0, stU, 0, nDofs * 4);
    enc.copyBufferToBuffer(buf.energy, 0, stE, 0, nElements * 4);
    enc.copyBufferToBuffer(buf.dc, 0, stDc, 0, nElements * 4);
    enc.copyBufferToBuffer(buf.scalars, 0, stSc, 0, SCALARS_COUNT * 4);
    queue.submit([enc.finish()]);

    const U = globalU && globalU.length === nDofs ? globalU : new Float32Array(nDofs);
    const energy = elementEnergies && elementEnergies.length === nElements
      ? elementEnergies
      : new Float32Array(nElements);
    const dc = new Float32Array(nElements);
    const sc = new Float32Array(SCALARS_COUNT);

    await Promise.all([
      this._mapRead(stU, nDofs * 4, U),
      this._mapRead(stE, nElements * 4, energy),
      this._mapRead(stDc, nElements * 4, dc),
      this._mapRead(stSc, SCALARS_COUNT * 4, sc),
    ]);
    stU.destroy();
    stE.destroy();
    stDc.destroy();
    stSc.destroy();

    let maxDisp = 0;
    let compliance = 0;
    for (let i = 0; i < nDofs; i++) {
      if (fixedDofs[i]) U[i] = 0;
      const mag = Math.abs(U[i]);
      if (mag > maxDisp) maxDisp = mag;
    }
    for (let i = 0; i < nElements; i++) compliance += energy[i];

    const currentRes = Math.sqrt(Math.max(0, sc[SLOT_RES2] || sc[SLOT_RZ]));
    if (elementEnergies && elementEnergies !== energy) elementEnergies.set(energy);

    return {
      dc,
      compliance,
      cgResidual: currentRes || cgTol,
      maxDisp,
      U,
      cgIters: this._fixedIters || DEFAULT_MAX_ITERS,
    };
  }
}
