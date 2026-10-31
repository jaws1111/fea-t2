// Matrix-free PCG for structured Hex8 TopOpt — GPU-resident scalars (no CPU sync in loop).
//
// node = ix + iy*(nx+1) + iz*(nx+1)*(ny+1)
// dof  = 3*node + comp
// elem = ex + ey*nx + ez*nx*ny
//
// Scalars buffer layout (f32):
//   0 rzOld   1 pAp   2 alpha   3 beta   4 rzNew   5 residualSq   6 slot (scratch)

struct Params {
  nx: u32,
  ny: u32,
  nz: u32,
  nDofs: u32,
  nElements: u32,
  penal: f32,
  Emin: f32,
  E0: f32,
  alpha: f32,
  beta: f32,
  reduceSlot: u32,
  nPartials: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<uniform> KEu: array<vec4<f32>, 144>;
@group(0) @binding(2) var<storage, read_write> xPhys: array<f32>;
@group(0) @binding(3) var<storage, read_write> fixedMask: array<u32>;
@group(0) @binding(4) var<storage, read_write> invDiag: array<f32>;
@group(0) @binding(5) var<storage, read_write> vA: array<f32>;
@group(0) @binding(6) var<storage, read_write> vB: array<f32>;
@group(0) @binding(7) var<storage, read_write> vC: array<f32>;
@group(0) @binding(8) var<storage, read_write> partials: array<f32>;
@group(0) @binding(9) var<storage, read_write> scalars: array<f32>;

const WG: u32 = 256u;

var<private> LX: array<u32, 8> = array<u32, 8>(0u, 1u, 1u, 0u, 0u, 1u, 1u, 0u);
var<private> LY: array<u32, 8> = array<u32, 8>(0u, 0u, 1u, 1u, 0u, 0u, 1u, 1u);
var<private> LZ: array<u32, 8> = array<u32, 8>(0u, 0u, 0u, 0u, 1u, 1u, 1u, 1u);

var<workgroup> sdata: array<f32, 256>;

fn ke(idx: u32) -> f32 {
  return KEu[idx >> 2u][idx & 3u];
}

fn simp_E(rho: f32) -> f32 {
  let r = max(rho, 0.0);
  if (r <= 0.0) {
    return params.Emin;
  }
  return params.Emin + pow(r, params.penal) * (params.E0 - params.Emin);
}

@compute @workgroup_size(256)
fn spmv_gather(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dof = gid.x;
  if (dof >= params.nDofs) {
    return;
  }
  if (fixedMask[dof] != 0u) {
    vB[dof] = vA[dof];
    return;
  }

  let nxp = params.nx + 1u;
  let nyp = params.ny + 1u;
  let node = dof / 3u;
  let comp = dof - node * 3u;
  let ix = node % nxp;
  let iy = (node / nxp) % nyp;
  let iz = node / (nxp * nyp);

  var sum = 0.0;
  for (var ln = 0u; ln < 8u; ln = ln + 1u) {
    let lx = LX[ln];
    let ly = LY[ln];
    let lz = LZ[ln];
    if (ix < lx || iy < ly || iz < lz) {
      continue;
    }
    let ex = ix - lx;
    let ey = iy - ly;
    let ez = iz - lz;
    if (ex >= params.nx || ey >= params.ny || ez >= params.nz) {
      continue;
    }

    let e = ex + ey * params.nx + ez * params.nx * params.ny;
    let E = simp_E(xPhys[e]);
    let row = (ln * 3u + comp) * 24u;

    var s = 0.0;
    for (var m = 0u; m < 8u; m = m + 1u) {
      let cx = ex + LX[m];
      let cy = ey + LY[m];
      let cz = ez + LZ[m];
      let base = 3u * (cx + cy * nxp + cz * nxp * nyp);
      let col = row + m * 3u;
      s = s + ke(col) * vA[base]
            + ke(col + 1u) * vA[base + 1u]
            + ke(col + 2u) * vA[base + 2u];
    }
    sum = sum + E * s;
  }
  vB[dof] = sum;
}

@compute @workgroup_size(256)
fn build_invdiag(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dof = gid.x;
  if (dof >= params.nDofs) {
    return;
  }
  if (fixedMask[dof] != 0u) {
    invDiag[dof] = 1.0;
    return;
  }

  let nxp = params.nx + 1u;
  let nyp = params.ny + 1u;
  let node = dof / 3u;
  let comp = dof - node * 3u;
  let ix = node % nxp;
  let iy = (node / nxp) % nyp;
  let iz = node / (nxp * nyp);

  var d = 0.0;
  for (var ln = 0u; ln < 8u; ln = ln + 1u) {
    let lx = LX[ln];
    let ly = LY[ln];
    let lz = LZ[ln];
    if (ix < lx || iy < ly || iz < lz) {
      continue;
    }
    let ex = ix - lx;
    let ey = iy - ly;
    let ez = iz - lz;
    if (ex >= params.nx || ey >= params.ny || ez >= params.nz) {
      continue;
    }
    let e = ex + ey * params.nx + ez * params.nx * params.ny;
    let r = ln * 3u + comp;
    d = d + simp_E(xPhys[e]) * ke(r * 24u + r);
  }
  if (d < 1e-7) {
    invDiag[dof] = 1.0;
  } else {
    invDiag[dof] = 1.0 / d;
  }
}

@compute @workgroup_size(256)
fn jacobi_apply(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.nDofs) {
    return;
  }
  if (fixedMask[i] != 0u) {
    vB[i] = 0.0;
  } else {
    vB[i] = vA[i] * invDiag[i];
  }
}

// saxpy / saxpy_neg / xpay / scale_copy use GPU scalars (alpha=2, beta=3)
@compute @workgroup_size(256)
fn saxpy(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.nDofs) {
    return;
  }
  vB[i] = vB[i] + scalars[2] * vA[i];
}

@compute @workgroup_size(256)
fn saxpy_neg(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.nDofs) {
    return;
  }
  vB[i] = vB[i] - scalars[2] * vA[i];
}

@compute @workgroup_size(256)
fn xpay(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.nDofs) {
    return;
  }
  vB[i] = vA[i] + scalars[3] * vB[i];
}

@compute @workgroup_size(256)
fn scale_copy(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.nDofs) {
    return;
  }
  vB[i] = scalars[2] * vA[i];
}

@compute @workgroup_size(256)
fn residual_init(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.nDofs) {
    return;
  }
  if (fixedMask[i] != 0u) {
    vC[i] = 0.0;
  } else {
    vC[i] = vA[i] - vB[i];
  }
}

@compute @workgroup_size(256)
fn reduce_dot(
  @builtin(global_invocation_id) gid: vec3<u32>,
  @builtin(local_invocation_id) lid: vec3<u32>,
  @builtin(workgroup_id) wid: vec3<u32>
) {
  var v = 0.0;
  if (gid.x < params.nDofs) {
    v = vA[gid.x] * vB[gid.x];
  }
  sdata[lid.x] = v;
  workgroupBarrier();

  for (var s = WG / 2u; s > 0u; s = s >> 1u) {
    if (lid.x < s) {
      sdata[lid.x] = sdata[lid.x] + sdata[lid.x + s];
    }
    workgroupBarrier();
  }

  if (lid.x == 0u) {
    partials[wid.x] = sdata[0];
  }
}

// Collapse partials → scalars[reduceSlot] (dispatch 1 workgroup)
@compute @workgroup_size(256)
fn final_reduce(
  @builtin(local_invocation_id) lid: vec3<u32>
) {
  var sum = 0.0;
  var i = lid.x;
  loop {
    if (i >= params.nPartials) {
      break;
    }
    sum = sum + partials[i];
    i = i + WG;
  }
  sdata[lid.x] = sum;
  workgroupBarrier();

  for (var s = WG / 2u; s > 0u; s = s >> 1u) {
    if (lid.x < s) {
      sdata[lid.x] = sdata[lid.x] + sdata[lid.x + s];
    }
    workgroupBarrier();
  }

  if (lid.x == 0u) {
    scalars[params.reduceSlot] = sdata[0];
  }
}

// alpha = rzOld / pAp  (slots 0 / 1 → 2)
@compute @workgroup_size(1)
fn pcg_set_alpha() {
  let rz = scalars[0];
  let pap = scalars[1];
  if (abs(pap) < 1e-15) {
    scalars[2] = 0.0;
  } else {
    scalars[2] = rz / pap;
  }
}

// beta = rzNew / rzOld; rzOld = rzNew; residualSq = rzNew
@compute @workgroup_size(1)
fn pcg_set_beta() {
  let rzOld = scalars[0];
  let rzNew = scalars[4];
  if (abs(rzOld) < 1e-30) {
    scalars[3] = 0.0;
  } else {
    scalars[3] = rzNew / rzOld;
  }
  scalars[0] = rzNew;
  scalars[5] = max(rzNew, 0.0);
}

// Seed alpha=1 for p = z copy
@compute @workgroup_size(1)
fn pcg_seed_alpha_one() {
  scalars[2] = 1.0;
  scalars[3] = 0.0;
}

// Element sensitivity / compliance contribution → vA[e]=dc, vB[e]=energy; scalar[6]+=compliance via atomics unavailable —
// host sums energies after readback of vB. dc written to vC for elements.
@compute @workgroup_size(256)
fn element_energy(
  @builtin(global_invocation_id) gid: vec3<u32>
) {
  let e = gid.x;
  if (e >= params.nElements) {
    return;
  }
  let nxp = params.nx + 1u;
  let nyp = params.ny + 1u;
  let ex = e % params.nx;
  let ey = (e / params.nx) % params.ny;
  let ez = e / (params.nx * params.ny);

  // Local U into registers (fixed → 0). Node order matches CPU.
  var u0 = 0.0; var u1 = 0.0; var u2 = 0.0;
  var u3 = 0.0; var u4 = 0.0; var u5 = 0.0;
  var u6 = 0.0; var u7 = 0.0; var u8 = 0.0;
  var u9 = 0.0; var u10 = 0.0; var u11 = 0.0;
  var u12 = 0.0; var u13 = 0.0; var u14 = 0.0;
  var u15 = 0.0; var u16 = 0.0; var u17 = 0.0;
  var u18 = 0.0; var u19 = 0.0; var u20 = 0.0;
  var u21 = 0.0; var u22 = 0.0; var u23 = 0.0;

  // Use vA as U (displacements), vB as energy out, vC as dc out — rebound by host.
  // Reading U from binding 5 (vA).
  for (var m = 0u; m < 8u; m = m + 1u) {
    let cx = ex + LX[m];
    let cy = ey + LY[m];
    let cz = ez + LZ[m];
    let n = cx + cy * nxp + cz * nxp * nyp;
    let base = 3u * n;
    let lu0 = select(vA[base], 0.0, fixedMask[base] != 0u);
    let lu1 = select(vA[base + 1u], 0.0, fixedMask[base + 1u] != 0u);
    let lu2 = select(vA[base + 2u], 0.0, fixedMask[base + 2u] != 0u);
    // store into flat local via if chain
    let o = m * 3u;
    if (o == 0u) { u0 = lu0; u1 = lu1; u2 = lu2; }
    else if (o == 3u) { u3 = lu0; u4 = lu1; u5 = lu2; }
    else if (o == 6u) { u6 = lu0; u7 = lu1; u8 = lu2; }
    else if (o == 9u) { u9 = lu0; u10 = lu1; u11 = lu2; }
    else if (o == 12u) { u12 = lu0; u13 = lu1; u14 = lu2; }
    else if (o == 15u) { u15 = lu0; u16 = lu1; u17 = lu2; }
    else if (o == 18u) { u18 = lu0; u19 = lu1; u20 = lu2; }
    else { u21 = lu0; u22 = lu1; u23 = lu2; }
  }

  var localU: array<f32, 24>;
  localU[0] = u0; localU[1] = u1; localU[2] = u2;
  localU[3] = u3; localU[4] = u4; localU[5] = u5;
  localU[6] = u6; localU[7] = u7; localU[8] = u8;
  localU[9] = u9; localU[10] = u10; localU[11] = u11;
  localU[12] = u12; localU[13] = u13; localU[14] = u14;
  localU[15] = u15; localU[16] = u16; localU[17] = u17;
  localU[18] = u18; localU[19] = u19; localU[20] = u20;
  localU[21] = u21; localU[22] = u22; localU[23] = u23;

  var ce = 0.0;
  for (var i = 0u; i < 24u; i = i + 1u) {
    let ui = localU[i];
    if (ui == 0.0) { continue; }
    for (var j = 0u; j < 24u; j = j + 1u) {
      let uj = localU[j];
      if (uj != 0.0) {
        ce = ce + ui * ke(i * 24u + j) * uj;
      }
    }
  }
  ce = max(ce, 1e-8);
  let rho = xPhys[e];
  let E = simp_E(rho);
  let strain = E * ce;
  vB[e] = strain;
  let rp = max(rho, 1e-4);
  vC[e] = -params.penal * pow(rp, params.penal - 1.0) * (params.E0 - params.Emin) * ce;
}
