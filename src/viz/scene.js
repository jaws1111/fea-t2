import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

const BG_HEX = 0x0b0f19;
const CAMERA_DIR = new THREE.Vector3(0.55, 0.42, 0.72).normalize();

/** Radial studio backdrop: slightly lifted centre fading into #0b0f19. */
function createBackdropTexture() {
  const size = 512;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size * 0.5, size * 0.42, size * 0.02, size * 0.5, size * 0.5, size * 0.75);
  g.addColorStop(0, '#182036');
  g.addColorStop(0.55, '#0f1524');
  g.addColorStop(1, '#0b0f19');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Create the Three.js scene, camera, renderer, controls, studio lights and ground.
 *
 * @param {{ container: HTMLElement, canvas: HTMLCanvasElement }} opts
 */
export function initThreeScene({ container, canvas }) {
  const scene = new THREE.Scene();
  scene.background = createBackdropTexture();

  const width = Math.max(1, container.clientWidth);
  const height = Math.max(1, container.clientHeight);

  const camera = new THREE.PerspectiveCamera(40, width / height, 0.1, 1000);
  camera.position.set(24, 18, 30);

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(width, height, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // Shadows are static between solver updates; re-render the map only on demand.
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.minDistance = 4;
  controls.maxDistance = 400;

  // --- Image-based ambient for believable metal / roughness response ---
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = envTex;
  scene.environmentIntensity = 0.55;
  pmrem.dispose();

  // --- Three-point studio lighting ---
  const hemi = new THREE.HemisphereLight(0x9db4ff, 0x1a1030, 0.35);
  scene.add(hemi);

  const keyLight = new THREE.DirectionalLight(0xfff3e0, 2.4);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(2048, 2048);
  keyLight.shadow.bias = -0.0004;
  keyLight.shadow.normalBias = 0.04;
  keyLight.shadow.radius = 3;
  scene.add(keyLight);
  scene.add(keyLight.target);

  const fillLight = new THREE.DirectionalLight(0x6f86ff, 0.9);
  scene.add(fillLight);
  scene.add(fillLight.target);

  const rimLight = new THREE.DirectionalLight(0x22d3ee, 1.4);
  scene.add(rimLight);
  scene.add(rimLight.target);

  // --- Ground: grid + shadow catcher ---
  const ground = new THREE.Group();
  const grid = new THREE.GridHelper(80, 40, 0x2a3552, 0x161e33);
  grid.material.transparent = true;
  grid.material.opacity = 0.75;
  grid.material.depthWrite = false;
  ground.add(grid);

  const shadowCatcher = new THREE.Mesh(
    new THREE.PlaneGeometry(200, 200),
    new THREE.ShadowMaterial({ color: 0x000000, opacity: 0.38 }),
  );
  shadowCatcher.rotation.x = -Math.PI / 2;
  shadowCatcher.position.y = 0.01;
  shadowCatcher.receiveShadow = true;
  ground.add(shadowCatcher);
  scene.add(ground);

  const fixturesGroup = new THREE.Group();
  fixturesGroup.name = 'boundary-fixtures';
  scene.add(fixturesGroup);

  function layoutLights(radius) {
    const d = Math.max(radius, 10);
    keyLight.position.set(d * 1.1, d * 1.7, d * 1.0);
    keyLight.target.position.set(0, 0, 0);
    const s = keyLight.shadow.camera;
    const ext = d * 1.35;
    s.left = -ext;
    s.right = ext;
    s.top = ext;
    s.bottom = -ext;
    s.near = 0.5;
    s.far = d * 6;
    s.updateProjectionMatrix();

    fillLight.position.set(-d * 1.4, d * 0.5, d * 0.6);
    rimLight.position.set(-d * 0.4, d * 0.9, -d * 1.6);
  }

  /** @param {number} y */
  function setGroundY(y) {
    ground.position.y = y;
  }

  /** Frame the camera on the voxel domain. */
  function frameDomain(dims) {
    const radius = 0.5 * Math.sqrt(dims.nx * dims.nx + dims.ny * dims.ny + dims.nz * dims.nz);
    const dist = (radius / Math.sin(THREE.MathUtils.degToRad(camera.fov) / 2)) * 1.05;
    camera.position.copy(CAMERA_DIR).multiplyScalar(dist);
    controls.target.set(0, 0, 0);
    controls.update();
    layoutLights(radius);
    renderer.shadowMap.needsUpdate = true;
  }

  function resetCamera(dims) {
    if (dims) {
      frameDomain(dims);
      return;
    }
    camera.position.set(24, 18, 30);
    controls.target.set(0, 0, 0);
    controls.update();
  }

  function resize() {
    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  }

  const resizeObserver = new ResizeObserver(() => resize());
  resizeObserver.observe(container);
  window.addEventListener('resize', resize);

  /** Request a shadow-map refresh on the next render. */
  function invalidateShadows() {
    renderer.shadowMap.needsUpdate = true;
  }

  function render() {
    controls.update();
    renderer.render(scene, camera);
  }

  function dispose() {
    resizeObserver.disconnect();
    window.removeEventListener('resize', resize);
    controls.dispose();
    envTex.dispose();
    renderer.dispose();
  }

  layoutLights(15);

  return {
    scene,
    camera,
    renderer,
    controls,
    grid,
    ground,
    fixturesGroup,
    lights: { hemi, keyLight, fillLight, rimLight },
    setGroundY,
    frameDomain,
    resetCamera,
    resize,
    invalidateShadows,
    render,
    dispose,
    /** Assigned by main.js: re-run updateVisualization with cached solver data. */
    redraw: () => {},
  };
}

export { BG_HEX };
