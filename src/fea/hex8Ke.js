/**
 * Unit cube Hex8 isoparametric stiffness (24×24), ν = 0.3, E = 1 (factored into SIMP scaling).
 * @returns {Float32Array} KE_24x24 length 576
 */
export function computeHex8Ke() {
  const ke = new Float32Array(24 * 24);
  const nu = 0.3;
  const coords = [
    [-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5],
    [-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5],
  ];
  const factor = 1.0 / ((1.0 + nu) * (1.0 - 2.0 * nu));
  const c11 = factor * (1.0 - nu);
  const c12 = factor * nu;
  const c44 = factor * (0.5 - nu);
  const g = 1.0 / Math.sqrt(3.0);
  const gp = [-g, g];

  for (const gx of gp) {
    for (const gy of gp) {
      for (const gz of gp) {
        const dN = [];
        for (let n = 0; n < 8; n++) {
          const [cx, cy, cz] = coords[n];
          const dNdx = (cx * 2) * 0.5 * (1 + 2 * cy * gy) * (1 + 2 * cz * gz) * 0.25;
          const dNdy = (cy * 2) * 0.5 * (1 + 2 * cx * gx) * (1 + 2 * cz * gz) * 0.25;
          const dNdz = (cz * 2) * 0.5 * (1 + 2 * cx * gx) * (1 + 2 * cy * gy) * 0.25;
          dN.push([dNdx, dNdy, dNdz]);
        }

        for (let i = 0; i < 8; i++) {
          const dNxi = dN[i][0];
          const dNyi = dN[i][1];
          const dNzi = dN[i][2];
          for (let j = 0; j < 8; j++) {
            const dNxj = dN[j][0];
            const dNyj = dN[j][1];
            const dNzj = dN[j][2];
            const k00 = c11 * dNxi * dNxj + c44 * (dNyi * dNyj + dNzi * dNzj);
            const k01 = c12 * dNxi * dNyj + c44 * dNyi * dNxj;
            const k02 = c12 * dNxi * dNzj + c44 * dNzi * dNxj;
            const k10 = c12 * dNyi * dNxj + c44 * dNxi * dNyj;
            const k11 = c11 * dNyi * dNyj + c44 * (dNxi * dNxj + dNzi * dNzj);
            const k12 = c12 * dNyi * dNzj + c44 * dNzi * dNyj;
            const k20 = c12 * dNzi * dNxj + c44 * dNxi * dNzj;
            const k21 = c12 * dNzi * dNyj + c44 * dNyi * dNzj;
            const k22 = c11 * dNzi * dNzj + c44 * (dNxi * dNxj + dNyi * dNyj);

            const r0 = i * 3;
            const r1 = i * 3 + 1;
            const r2 = i * 3 + 2;
            const c0 = j * 3;
            const c1 = j * 3 + 1;
            const c2 = j * 3 + 2;

            ke[r0 * 24 + c0] += k00;
            ke[r0 * 24 + c1] += k01;
            ke[r0 * 24 + c2] += k02;
            ke[r1 * 24 + c0] += k10;
            ke[r1 * 24 + c1] += k11;
            ke[r1 * 24 + c2] += k12;
            ke[r2 * 24 + c0] += k20;
            ke[r2 * 24 + c1] += k21;
            ke[r2 * 24 + c2] += k22;
          }
        }
      }
    }
  }
  return ke;
}

/** Precomputed stiffness matrix (worker parity). */
export const KE_24x24 = computeHex8Ke();
