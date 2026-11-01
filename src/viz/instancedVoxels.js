import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { updateVisualization } from './updateVisualization.js';
import { aoUniform } from './voxelShared.js';

/**
 * Voxel renderer: ONE instanced draw call for the visible voxels only.
 *
 *  - Instances are compacted on the CPU (see updateVisualization.js): void voxels and fully
 *    enclosed solid interiors are never submitted, so cost follows the visible surface, not the
 *    grid size (the previous renderer drew every cell, hidden ones as degenerate cubes).
 *  - Per-instance data is 9 floats (cell centre, scale, colour, neighbour mask) instead of a
 *    16-float matrix + colour; the transform happens in the vertex shader.
 *  - Ambient occlusion is evaluated per vertex from a 26-neighbour occupancy mask (classic voxel
 *    AO, no screen-space pass, no extra render target).
 *  - Level of detail: the cube mesh gets coarser as the visible count grows.
 *  - Shadows use a matching depth material (same instance transform).
 *
 * The mesh is a regular THREE.Mesh; `mesh.userData.voxels` holds the buffers.
 */

/** Cube edge (the old rounded box was 0.95 wide: a thin gap between neighbouring voxels). */
const EDGE = 0.95;
const BEVEL = 0.09;

const VERTEX_DECL = /* glsl */ `
attribute vec3 aPos;
attribute vec3 aColor;
attribute float aScale;
attribute vec2 aOcc;
varying vec3 vInstColor;
varying float vAO;
uniform float uAO;

// Neighbour (dx,dy,dz) in {-1,0,1}^3 \\ {0}: 26 bits, 13 in each float of aOcc.
float occAt(vec3 d) {
  float n = (d.x + 1.0) + 3.0 * (d.y + 1.0) + 9.0 * (d.z + 1.0);
  float b = n < 13.0 ? n : n - 1.0;
  float v = b < 13.0 ? aOcc.x : aOcc.y;
  float k = b < 13.0 ? b : b - 13.0;
  return mod(floor(v / exp2(k)), 2.0);
}

// AO of the corner of this voxel at octant s, seen from the face along 'axis' whose side is sa.
float faceAO(int axis, float sa, vec3 s) {
  int b = (axis + 1) % 3;
  int c = (axis + 2) % 3;
  vec3 d1 = vec3(0.0);
  vec3 d2 = vec3(0.0);
  vec3 d3 = vec3(0.0);
  d1[axis] = sa; d1[b] = s[b];
  d2[axis] = sa; d2[c] = s[c];
  d3[axis] = sa; d3[b] = s[b]; d3[c] = s[c];
  float s1 = occAt(d1);
  float s2 = occAt(d2);
  float cr = occAt(d3);
  return (s1 + s2 > 1.5) ? 0.0 : (3.0 - s1 - s2 - cr) / 3.0;
}
`;

const VERTEX_TRANSFORM = /* glsl */ `
vec3 transformed = position * aScale + aPos;
vInstColor = aColor;
{
  vec3 s = vec3(position.x >= 0.0 ? 1.0 : -1.0, position.y >= 0.0 ? 1.0 : -1.0, position.z >= 0.0 ? 1.0 : -1.0);
  vec3 w = objectNormal * objectNormal;
  float ao = w.x * faceAO(0, objectNormal.x >= 0.0 ? 1.0 : -1.0, s)
           + w.y * faceAO(1, objectNormal.y >= 0.0 ? 1.0 : -1.0, s)
           + w.z * faceAO(2, objectNormal.z >= 0.0 ? 1.0 : -1.0, s);
  vAO = mix(1.0, mix(0.28, 1.0, ao), uAO);
}
`;

function makeMaterial() {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.38, metalness: 0.25 });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uAO = aoUniform;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_DECL}`)
      .replace('#include <begin_vertex>', VERTEX_TRANSFORM);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vInstColor;\nvarying float vAO;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= vInstColor;')
      .replace(
        '#include <aomap_fragment>',
        `#include <aomap_fragment>
reflectedLight.indirectDiffuse *= vAO;
reflectedLight.indirectSpecular *= mix(1.0, vAO, 0.7);
reflectedLight.directDiffuse *= mix(1.0, vAO, 0.35);`,
      );
  };
  mat.customProgramCacheKey = () => 'voxel-instanced-ao';
  return mat;
}

function makeDepthMaterial() {
  const mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aPos;\nattribute float aScale;')
      .replace('#include <begin_vertex>', 'vec3 transformed = position * aScale + aPos;');
  };
  mat.customProgramCacheKey = () => 'voxel-instanced-depth';
  return mat;
}

/** Cube meshes of decreasing detail, all sharing the same instance attributes. */
function makeCubeGeometries() {
  const bare = new THREE.BoxGeometry(EDGE, EDGE, EDGE);
  return [
    new RoundedBoxGeometry(EDGE, EDGE, EDGE, 2, BEVEL), // 300 tris
    new RoundedBoxGeometry(EDGE, EDGE, EDGE, 1, BEVEL),
    bare, // 12 tris
  ].map((g) => {
    const ig = new THREE.InstancedBufferGeometry();
    ig.index = g.index;
    ig.setAttribute('position', g.attributes.position);
    ig.setAttribute('normal', g.attributes.normal);
    return ig;
  });
}

/**
 * Build the voxel mesh for an nx × ny × nz grid. The caller owns scene membership.
 *
 * @param {{ nx: number, ny: number, nz: number, volfrac?: number }} config
 * @param {{ scene?: THREE.Scene, previous?: THREE.Mesh | null }} [options]
 * @returns {THREE.Mesh}
 */
export function rebuildDomainAndMesh(config, options = {}) {
  const { scene, previous } = options;
  const { nx, ny, nz } = config;
  const total = nx * ny * nz;

  if (previous) {
    if (scene) scene.remove(previous);
    disposeVoxelMesh(previous);
  }

  const attrs = {
    aPos: new THREE.InstancedBufferAttribute(new Float32Array(total * 3), 3),
    aColor: new THREE.InstancedBufferAttribute(new Float32Array(total * 3), 3),
    aScale: new THREE.InstancedBufferAttribute(new Float32Array(total), 1),
    aOcc: new THREE.InstancedBufferAttribute(new Float32Array(total * 2), 2),
  };
  for (const a of Object.values(attrs)) a.setUsage(THREE.DynamicDrawUsage);

  const geoms = makeCubeGeometries();
  for (const g of geoms) {
    for (const [name, a] of Object.entries(attrs)) g.setAttribute(name, a);
    g.instanceCount = 0;
  }

  const mesh = new THREE.Mesh(geoms[0], makeMaterial());
  mesh.name = 'voxels';
  mesh.frustumCulled = false; // the whole grid is nearly always in view
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.customDepthMaterial = makeDepthMaterial();
  mesh.userData.voxels = {
    cells: total,
    geoms,
    attrs,
    solid: new Uint8Array(total),
    opaque: new Uint8Array(total),
    visible: 0,
  };

  // Seed with a uniform block so the viewport is never empty before the first solver update.
  updateVisualization({
    mesh,
    densities: new Float32Array(total).fill(config.volfrac ?? 0.35),
    config: { ...config, cutoff: 0, defScale: 0, viewMode: 'cubes', colorMode: 'density', ao: false },
  });

  if (scene) scene.add(mesh);
  return mesh;
}

/** Free GPU resources of the voxel mesh. */
export function disposeVoxelMesh(mesh) {
  if (!mesh) return;
  mesh.parent?.remove(mesh);
  const v = mesh.userData?.voxels;
  // The instance buffers are shared by the three geometries; disposing each releases them once.
  if (v) for (const g of v.geoms) g.dispose();
  mesh.material?.dispose();
  mesh.customDepthMaterial?.dispose();
}
