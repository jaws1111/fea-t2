// GPU-resident SIMP update: sensitivity filter + OC bisection + density update + reductions.
// Keeps the whole optimisation iteration on the device so the GPU is never waiting on
// CPU-side filter / OC loops. Companion to kernels.wgsl (FEA).
//
// elem = ex + ey*nx + ez*nx*ny      node = ix + iy*(nx+1) + iz*(nx+1)*(ny+1)
//
// oc[] layout (f32):
//   0 lo (ln lambda)   1 hi (ln lambda)   2 lambda (linear)   3 mid (ln lambda)
//   4 avgVolume        5 compliance       6 maxAbsDispY       7 reserved

struct SimpParams {
  nx: u32,
  ny: u32,
  nz: u32,
  nElements: u32,
  rmin: f32,
  rCeil: u32,
  moveLimit: f32,
  xmin: f32,
  targetVol: f32,
  nPartials: u32,
  hasPassive: u32,
  pad: u32,
}

@group(0) @binding(0) var<uniform> sp: SimpParams;
@group(0) @binding(1) var<storage, read_write> xPhys: array<f32>;
@group(0) @binding(2) var<storage, read_write> dc: array<f32>;
@group(0) @binding(3) var<storage, read_write> dcf: array<f32>;
@group(0) @binding(4) var<storage, read_write> passive: array<u32>;
@group(0) @binding(5) var<storage, read_write> partials: array<f32>;
@group(0) @binding(6) var<storage, read_write> oc: array<f32>;
@group(0) @binding(7) var<storage, read_write> energy: array<f32>;
@group(0) @binding(8) var<storage, read_write> U: array<f32>;
@group(0) @binding(9) var<storage, read_write> dispY: array<f32>;

const WG: u32 = 256u;
var<workgroup> sdata: array<f32, 256>;

// Density-weighted sensitivity filter (matches CPU sensitivityFilter.js).
@compute @workgroup_size(128)
fn filter_dc(@builtin(global_invocation_id) gid: vec3<u32>) {
  let e = gid.x;
  if (e >= sp.nElements) {
    return;
  }
  let nx = sp.nx;
  let ny = sp.ny;
  let ex = i32(e % nx);
  let ey = i32((e / nx) % ny);
  let ez = i32(e / (nx * ny));
  let inx = i32(nx);
  let iny = i32(ny);
  let inz = i32(sp.nz);
  let r = i32(sp.rCeil);
  let rmin = sp.rmin;
  let rmin2 = rmin * rmin;

  var sumW = 0.0;
  var sumWdc = 0.0;
  let z0 = max(ez - r, 0);
  let z1 = min(ez + r, inz - 1);
  let y0 = max(ey - r, 0);
  let y1 = min(ey + r, iny - 1);
  let x0 = max(ex - r, 0);
  let x1 = min(ex + r, inx - 1);
  for (var kz = z0; kz <= z1; kz = kz + 1) {
    let dz = f32(kz - ez);
    let dz2 = dz * dz;
    if (dz2 >= rmin2) { continue; }
    for (var ky = y0; ky <= y1; ky = ky + 1) {
      let dy = f32(ky - ey);
      let dzy2 = dz2 + dy * dy;
      if (dzy2 >= rmin2) { continue; }
      let rowBase = u32(kz * iny * inx + ky * inx);
      for (var kx = x0; kx <= x1; kx = kx + 1) {
        let dx = f32(kx - ex);
        let d2 = dzy2 + dx * dx;
        if (d2 >= rmin2) { continue; }
        let w = rmin - sqrt(d2);
        let k = rowBase + u32(kx);
        sumW = sumW + w;
        sumWdc = sumWdc + w * xPhys[k] * dc[k];
      }
    }
  }
  if (sumW <= 0.0) {
    dcf[e] = dc[e];
  } else {
    dcf[e] = sumWdc / (max(xPhys[e], 1e-3) * sumW);
  }
}

fn candidate(i: u32, lambda: f32) -> f32 {
  if (sp.hasPassive != 0u) {
    let p = passive[i];
    if (p == 1u) { return sp.xmin; }
    if (p == 2u) { return 1.0; }
  }
  let x = xPhys[i];
  let b = sqrt(max(0.0, -dcf[i] / max(lambda, 1e-30)));
  let trial = x * b;
  return max(sp.xmin, max(x - sp.moveLimit, min(1.0, min(x + sp.moveLimit, trial))));
}

fn reduce_to(lid: u32, wid: u32, v: f32) {
  sdata[lid] = v;
  workgroupBarrier();
  for (var s = WG / 2u; s > 0u; s = s >> 1u) {
    if (lid < s) {
      sdata[lid] = sdata[lid] + sdata[lid + s];
    }
    workgroupBarrier();
  }
  if (lid == 0u) {
    partials[wid] = sdata[0];
  }
}

fn sum_partials(lid: u32) -> f32 {
  var sum = 0.0;
  var i = lid;
  loop {
    if (i >= sp.nPartials) { break; }
    sum = sum + partials[i];
    i = i + WG;
  }
  sdata[lid] = sum;
  workgroupBarrier();
  for (var s = WG / 2u; s > 0u; s = s >> 1u) {
    if (lid < s) {
      sdata[lid] = sdata[lid] + sdata[lid + s];
    }
    workgroupBarrier();
  }
  let total = sdata[0];
  workgroupBarrier();
  return total;
}

@compute @workgroup_size(1)
fn oc_init() {
  let lo = log(1e-16);
  let hi = log(1e12);
  oc[0] = lo;
  oc[1] = hi;
  oc[3] = 0.5 * (lo + hi);
  oc[2] = exp(oc[3]);
}

@compute @workgroup_size(256)
fn oc_candidate_sum(
  @builtin(global_invocation_id) gid: vec3<u32>,
  @builtin(local_invocation_id) lid: vec3<u32>,
  @builtin(workgroup_id) wid: vec3<u32>
) {
  var v = 0.0;
  if (gid.x < sp.nElements) {
    v = candidate(gid.x, oc[2]);
  }
  reduce_to(lid.x, wid.x, v);
}

// One log-space bisection step on lambda (volume decreases as lambda grows).
@compute @workgroup_size(256)
fn oc_bisect_step(@builtin(local_invocation_id) lid: vec3<u32>) {
  let vol = sum_partials(lid.x);
  if (lid.x == 0u) {
    var lo = oc[0];
    var hi = oc[1];
    let mid = oc[3];
    if (vol > sp.targetVol) {
      lo = mid;
    } else {
      hi = mid;
    }
    let nm = 0.5 * (lo + hi);
    oc[0] = lo;
    oc[1] = hi;
    oc[3] = nm;
    oc[2] = exp(nm);
  }
}

// Commit the OC update in place (each element reads/writes only itself).
@compute @workgroup_size(256)
fn oc_apply(
  @builtin(global_invocation_id) gid: vec3<u32>,
  @builtin(local_invocation_id) lid: vec3<u32>,
  @builtin(workgroup_id) wid: vec3<u32>
) {
  var v = 0.0;
  if (gid.x < sp.nElements) {
    v = candidate(gid.x, oc[2]);
    xPhys[gid.x] = v;
  }
  reduce_to(lid.x, wid.x, v);
}

@compute @workgroup_size(256)
fn finalize_volume(@builtin(local_invocation_id) lid: vec3<u32>) {
  let vol = sum_partials(lid.x);
  if (lid.x == 0u) {
    oc[4] = vol / f32(sp.nElements);
  }
}

@compute @workgroup_size(256)
fn energy_sum(
  @builtin(global_invocation_id) gid: vec3<u32>,
  @builtin(local_invocation_id) lid: vec3<u32>,
  @builtin(workgroup_id) wid: vec3<u32>
) {
  var v = 0.0;
  if (gid.x < sp.nElements) {
    v = energy[gid.x];
  }
  reduce_to(lid.x, wid.x, v);
}

@compute @workgroup_size(256)
fn finalize_compliance(@builtin(local_invocation_id) lid: vec3<u32>) {
  let c = sum_partials(lid.x);
  if (lid.x == 0u) {
    oc[5] = c;
  }
}

// Per-element y-displacement at the element's origin node (for the displacement overlay).
@compute @workgroup_size(256)
fn disp_y(@builtin(global_invocation_id) gid: vec3<u32>) {
  let e = gid.x;
  if (e >= sp.nElements) {
    return;
  }
  let nxp = sp.nx + 1u;
  let nyp = sp.ny + 1u;
  let ex = e % sp.nx;
  let ey = (e / sp.nx) % sp.ny;
  let ez = e / (sp.nx * sp.ny);
  let node = ex + ey * nxp + ez * nxp * nyp;
  dispY[e] = U[3u * node + 1u];
}
