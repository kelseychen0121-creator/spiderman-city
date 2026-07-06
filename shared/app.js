// Shared viewer core: materials faithful to the Unity pack, LOD, sky, day/night.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Sky } from 'three/addons/objects/Sky.js';

const SHARED = new URL('.', import.meta.url); // .../web/shared/
const url = p => new URL(p, SHARED).href;
const SKY_VERSION = 8; // bump to bust the browser image cache after regenerating skies

export class Viewer {
  constructor(container, opts = {}) {
    this.opts = Object.assign({ shadowSize: 500, fov: 55 }, opts);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(this.opts.fov, innerWidth / innerHeight, 0.5, 12000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.495;

    this.sun = new THREE.DirectionalLight(0xffffff, 3.2);
    this.sun.castShadow = true;
    const s = this.opts.shadowSize;
    Object.assign(this.sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 50, far: 4000 });
    this.sun.shadow.camera.updateProjectionMatrix();
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.00004;
    this.sun.shadow.normalBias = 0.7;
    this.scene.add(this.sun, this.sun.target);

    this.hemi = new THREE.HemisphereLight(0xbdd3e8, 0x51504a, 0.9);
    this.scene.add(this.hemi);

    this.sky = new Sky();
    this.sky.scale.setScalar(50000);
    this.scene.add(this.sky);
    this.pmrem = new THREE.PMREMGenerator(this.renderer);

    this.models = {};   // name -> { lodMeshes: Mesh[], bbox }
    this.materials = null;
    this.mode = 'day';
    this.sunFocus = new THREE.Vector3();  // shadow/sun aim point (city center)
    this.modeHooks = [];                  // fn(mode) called on setMode

    addEventListener('resize', () => {
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(innerWidth, innerHeight);
    });
  }

  async loadTextures() {
    const tl = new THREE.TextureLoader();
    const load = (p, srgb, wrap) => new Promise((res, rej) => tl.load(url(p), t => {
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      if (wrap) t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = 8;
      // NOTE: GLB keeps FBXLoader's V-up UVs (exporter doesn't rewrite them), so default flipY=true is correct
      res(t);
    }, undefined, rej));
    const [hd, hn, ho, he, rd, rn, sd, sm, smr] = await Promise.all([
      load('textures/houses_diffuse.png', true),
      load('textures/houses_normal.png'),
      load('textures/houses_orm.png'),
      load('textures/houses_emission.png', true),
      load('textures/roads_diffuse.png', true),
      load('textures/roads_normal.png'),
      load('textures/spidey/suit_baseColor.png', true).catch(() => null),
      load('textures/spidey/mask_baseColor.png', true).catch(() => null),
      load('textures/spidey/suit_mr.png').catch(() => null),
    ]);
    // per-material texture patches for kind:'prop' models (matched by material name)
    this.propTex = {
      S_U_I_T: { map: sd, roughnessMap: smr, metalnessMap: smr },
      M_A_S_K: { map: sm },
    };
    // Unity pack: diffuse alpha = window mask -> baked into ORM (G=rough, B=metal).
    // Emission map = lit windows (original shader adds it unconditionally).
    this.materials = {
      houses: new THREE.MeshStandardMaterial({
        name: 'houses', map: hd, normalMap: hn,
        roughnessMap: ho, metalnessMap: ho, roughness: 1.0, metalness: 1.0,
        emissiveMap: he, emissive: new THREE.Color(0xffffff), emissiveIntensity: 1.0,
        envMapIntensity: 1.0,
      }),
      roads: new THREE.MeshStandardMaterial({
        name: 'roads', map: rd, normalMap: rn, roughness: 0.94, metalness: 0.0,
        envMapIntensity: 0.35,
      }),
    };
    return this.materials;
  }

  async loadModels(names) {
    const manifest = await (await fetch(url('models.json'))).json();
    this.manifest = manifest;
    const gl = new GLTFLoader();
    await Promise.all(names.map(name => new Promise((res, rej) => {
      const entry = manifest.models[name];
      gl.load(url(entry.file), g => {
        if (entry.kind === 'prop') {
          // keep own hierarchy/materials; attach textures by material name
          g.scene.traverse(o => {
            if (o.isMesh) {
              o.castShadow = true; o.receiveShadow = true;
              const patch = this.propTex[o.material?.name];
              if (patch) {
                for (const k in patch) if (patch[k]) o.material[k] = patch[k];
                if (patch.roughnessMap) { o.material.roughness = 1.0; o.material.metalness = 1.0; }
                o.material.needsUpdate = true;
              }
            }
          });
          const bb = entry.bbox;
          const size = Math.max(bb.max[0] - bb.min[0], bb.max[2] - bb.min[2], bb.max[1] - bb.min[1]);
          this.models[name] = { group: g.scene, size, entry };
          return res();
        }
        const meshes = [];
        g.scene.traverse(o => { if (o.isMesh) meshes.push(o); });
        meshes.sort((a, b) => a.name.localeCompare(b.name)); // _LOD0.._LOD2
        const mat = this.materials[entry.kind === 'road' ? 'roads' : 'houses'];
        for (const m of meshes) {
          m.material = mat;
          m.castShadow = entry.kind !== 'road';
          m.receiveShadow = true;
        }
        const bb = entry.bbox;
        const size = Math.max(bb.max[0] - bb.min[0], bb.max[2] - bb.min[2], bb.max[1] - bb.min[1]);
        this.models[name] = { lodMeshes: meshes, size, entry };
        res();
      }, undefined, rej);
    })));
  }

  // LOD switch distances from object size (screen-height heuristic, fov-aware)
  lodDistances(size) {
    const k = size / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)));
    return [0, k / 0.30, k / 0.10]; // switch when object < 30% / 10% of screen height
  }

  instantiate(name, pos = [0, 0, 0], rotY = 0, forceLod = -1) {
    const m = this.models[name];
    if (!m) throw new Error('model not loaded: ' + name);
    let obj;
    if (m.group) {
      obj = m.group.clone(true);
    } else if (forceLod >= 0) {
      obj = m.lodMeshes[Math.min(forceLod, m.lodMeshes.length - 1)].clone();
    } else if (m.lodMeshes.length > 1) {
      obj = new THREE.LOD();
      const d = this.lodDistances(m.size);
      m.lodMeshes.forEach((mesh, i) => obj.addLevel(mesh.clone(), d[i] ?? d[d.length - 1]));
    } else {
      obj = m.lodMeshes[0].clone();
    }
    obj.position.set(pos[0], pos[1], pos[2]);
    obj.rotation.y = rotY;
    this.scene.add(obj);
    return obj;
  }

  addGround(radius = 4000, color = 0x36393d) {
    const g = new THREE.Mesh(
      new THREE.CircleGeometry(radius, 48).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color, roughness: 1, metalness: 0 })
    );
    g.position.y = -0.08;
    g.receiveShadow = true;
    this.scene.add(g);
    return g;
  }

  // ---- HDRI skydome (day): tone-mapped offline from the EXR, sun direction in sky.json ----
  _ensureDaySky() {
    if (this._skyDome || this._skyLoading) return;
    this._skyLoading = true;
    this._loadDome('textures/sky/sky.json', 'textures/sky/day_sky.png')
      .then(({ dome, meta }) => {
        this._skyMeta = meta;
        this._skyDome = dome;
        if (this.mode === 'day') this.setMode('day'); // re-apply now that the dome exists
      })
      .catch(e => console.warn('day skydome load failed, keeping procedural sky', e));
  }

  _ensureNightSky() {
    if (this._nightDome || this._nightLoading) return;
    this._nightLoading = true;
    this._loadDome('textures/sky/night_sky.json', 'textures/sky/night_sky.png')
      .then(({ dome, meta }) => {
        this._nightMeta = meta;
        this._nightDome = dome;
        if (this.mode === 'night') this.setMode('night');
      })
      .catch(e => console.warn('night skydome load failed, keeping flat night sky', e));
  }

  _loadDome(metaPath, texPath) {
    return Promise.all([
      fetch(url(metaPath) + '?v=' + SKY_VERSION).then(r => r.json()),
      new Promise((res, rej) => new THREE.TextureLoader().load(url(texPath) + '?v=' + SKY_VERSION, res, undefined, rej)),
    ]).then(([meta, tex]) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      const dome = new THREE.Mesh(
        new THREE.SphereGeometry(6000, 48, 24),
        new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, toneMapped: false, fog: false, depthWrite: false })
      );
      dome.renderOrder = -1;
      dome.visible = false;
      this.scene.add(dome);
      return { dome, meta };
    });
  }

  setMode(mode) {
    this.mode = mode;
    const u = this.sky.material.uniforms;
    if (mode === 'day') {
      this._ensureDaySky();
      if (this._nightDome) this._nightDome.visible = false;
      this.sun.visible = true;
      this.sun.intensity = 3.2;
      this.sun.color.set(0xfff2df);
      this.hemi.intensity = 0.85;
      this.renderer.toneMappingExposure = 0.95;
      if (this.materials) this.materials.houses.emissiveIntensity = 1.0;
      this.scene.background = null;

      if (this._skyDome) {
        // HDRI dome: real sky wraps the whole map; sun/fog/ambient match the image
        this._skyDome.visible = true;
        this.sky.visible = false;
        const m = this._skyMeta;
        const dir = new THREE.Vector3(...m.sunDir);
        this.sun.position.copy(dir).multiplyScalar(1400).add(this.sunFocus);
        this.sun.target.position.copy(this.sunFocus);
        const fogC = new THREE.Color().setRGB(...m.horizon, THREE.SRGBColorSpace);
        const skyC = new THREE.Color().setRGB(...m.zenith, THREE.SRGBColorSpace);
        this.scene.fog = new THREE.FogExp2(fogC, 0.00045);
        this.hemi.color.copy(skyC).lerp(new THREE.Color(0xffffff), 0.35);
        this.hemi.groundColor.set(0x51504a);
        if (!this._dayEnvRT) {
          const envScene = new THREE.Scene();
          envScene.add(new THREE.Mesh(this._skyDome.geometry, this._skyDome.material));
          this._dayEnvRT = this.pmrem.fromScene(envScene, 0.02, 1, 9000);
        }
        this.scene.environment = this._dayEnvRT.texture;
        this.scene.environmentIntensity = 1.0;
      } else {
        // procedural fallback while the PNG streams in
        const sunPos = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - 38), THREE.MathUtils.degToRad(125));
        u.sunPosition.value.copy(sunPos);
        u.turbidity.value = 5; u.rayleigh.value = 1.6;
        u.mieCoefficient.value = 0.004; u.mieDirectionalG.value = 0.75;
        this.sky.visible = true;
        this.sun.position.copy(sunPos).multiplyScalar(1400).add(this.sunFocus);
        this.sun.target.position.copy(this.sunFocus);
        this.hemi.color.set(0xbdd3e8); this.hemi.groundColor.set(0x51504a);
        this.scene.fog = new THREE.FogExp2(0xc3d2e2, 0.00045);
        const envScene = new THREE.Scene();
        const skyClone = new Sky();
        skyClone.scale.setScalar(50000);
        for (const k in u) skyClone.material.uniforms[k].value = u[k].value;
        envScene.add(skyClone);
        const rt = this.pmrem.fromScene(envScene, 0.02);
        this.scene.environment = rt.texture;
        this.scene.environmentIntensity = 1.0;
      }
    } else { // night
      this._ensureNightSky();
      this.sky.visible = false;
      if (this._skyDome) this._skyDome.visible = false;
      this.sun.visible = true; // moonlight
      this.sun.intensity = 0.7;
      this.sun.color.set(0x9ab4de);
      this.sun.position.set(-900, 1500, -600).add(this.sunFocus);
      this.sun.target.position.copy(this.sunFocus);
      this.hemi.intensity = 0.5;
      this.renderer.toneMappingExposure = 1.1;
      if (this.materials) this.materials.houses.emissiveIntensity = 3.0;

      if (this._nightDome) {
        // HDRI night dome: dark sky overhead, warm town-glow at the horizon
        this._nightDome.visible = true;
        this.scene.background = null;
        const m = this._nightMeta;
        const fogC = new THREE.Color().setRGB(...m.horizon, THREE.SRGBColorSpace);
        this.scene.fog = new THREE.FogExp2(fogC, 0.00055);
        this.hemi.color.setRGB(...m.zenith, THREE.SRGBColorSpace).lerp(new THREE.Color(0x35466a), 0.6);
        this.hemi.groundColor.set(0x221d14);
        if (!this._nightEnvRT) {
          const envScene = new THREE.Scene();
          envScene.add(new THREE.Mesh(this._nightDome.geometry, this._nightDome.material));
          this._nightEnvRT = this.pmrem.fromScene(envScene, 0.02, 1, 9000);
        }
        this.scene.environment = this._nightEnvRT.texture;
        this.scene.environmentIntensity = 0.7;
      } else {
        this.scene.background = new THREE.Color(0x0b1322);
        this.hemi.color.set(0x35466a); this.hemi.groundColor.set(0x221d14);
        this.scene.fog = new THREE.FogExp2(0x0d1424, 0.00055);
        const c = new THREE.Color(0x131c30);
        const envScene = new THREE.Scene();
        envScene.background = c;
        this.scene.environment = this.pmrem.fromScene(envScene, 0.02).texture;
        this.scene.environmentIntensity = 0.6;
      }
    }
    for (const h of this.modeHooks) h(mode);
  }

  // The first-compiled light state (after PMREM pre-render) leaves the sun's shadow
  // sampling dead until the lights list changes once. Adding+removing an invisible
  // castShadow light forces a clean lights rebuild. Verified empirically.
  _kickShadows() {
    const kick = new THREE.DirectionalLight(0xffffff, 0);
    kick.castShadow = true;
    kick.shadow.mapSize.set(16, 16);
    this.scene.add(kick, kick.target);
    this.renderer.render(this.scene, this.camera);
    this.scene.remove(kick, kick.target);
    kick.shadow.dispose();
  }

  start(onFrame) {
    let frames = 0;
    this.renderer.setAnimationLoop(() => {
      if (this.controls.enabled) this.controls.update();
      onFrame && onFrame();
      this.renderer.render(this.scene, this.camera);
      if (++frames === 2) this._kickShadows();
      if (frames === 5) window.__vready = true; // headless screenshot hook
    });
  }

  stats() {
    const i = this.renderer.info;
    return `draws ${i.render.calls} · tris ${(i.render.triangles / 1000).toFixed(0)}k`;
  }
}

// shared tiny UI helper
export function makePanel(title) {
  const el = document.createElement('div');
  el.className = 'city-panel';
  el.style.cssText = 'position:fixed;top:12px;left:12px;background:rgba(12,14,18,.72);color:#e8edf4;font:13px/1.5 system-ui;padding:10px 14px;border-radius:10px;backdrop-filter:blur(6px);user-select:none;z-index:10;min-width:180px';
  el.innerHTML = `<div style="font-weight:600;margin-bottom:6px">${title}</div>`;
  document.body.appendChild(el);
  return el;
}

export function applyUrlOverrides(viewer) {
  const q = new URLSearchParams(location.search);
  if (q.get('mode')) viewer.setMode(q.get('mode'));
  const cam = q.get('cam'), tgt = q.get('target');
  if (cam) { const [x, y, z] = cam.split(',').map(Number); viewer.camera.position.set(x, y, z); }
  if (tgt) { const [x, y, z] = tgt.split(',').map(Number); viewer.controls.target.set(x, y, z); }
  return q;
}
