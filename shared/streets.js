// Procedural streetscape: sidewalk plates, green medians, zebra crossings,
// lane dashes, instanced trees (leaf-textured, real shadows) and street lamps.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const SHARED = new URL('.', import.meta.url);
const turl = p => new URL(p, SHARED).href;

function loadTex(p, srgb) {
  return new Promise((res, rej) => new THREE.TextureLoader().load(turl(p), t => {
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    res(t);
  }, undefined, rej));
}

// Distant-city skyline ring: simple textured towers far outside the play area.
// Fog turns them into a natural hazy skyline that hides the ground-plane edge;
// sharing the houses material means windows light up automatically at night.
export function buildSkyline(viewer, def, material) {
  const rand = rng((def.seed || 4242) + 7);
  const pitch = def.pitch, n = def.n;
  const cx = ((n - 1) * pitch) / 2, cz = cx;
  const geos = [];
  const COUNT = 260;
  for (let i = 0; i < COUNT; i++) {
    const a = rand() * Math.PI * 2;
    const rr = 1250 + Math.pow(rand(), 0.85) * 1150;        // 1250..2400m band
    const x = cx + Math.cos(a) * rr, z = cz + Math.sin(a) * rr;
    const w = 34 + rand() * 60, d = 34 + rand() * 60;
    const h = 45 + Math.pow(rand(), 2.0) * 300;             // mostly mid-rise, a few tall
    const g = new THREE.BoxGeometry(w, h, d);
    const uv = g.attributes.uv;
    const su = 0.45 + rand() * 0.55, sv = 0.45 + rand() * 0.55; // vary facade look, stay in [0,1]
    for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) * su, uv.getY(k) * sv);
    g.translate(x, h / 2 - 2, z);
    geos.push(g);
  }
  // pure silhouette (unlit): flat haze-blue by day; at night the emission map
  // itself becomes the surface — black body, warm lit windows
  const emisTex = material.emissiveMap || null;
  const mat = new THREE.MeshBasicMaterial({ color: 0x606c7c });
  const applyMode = m => {
    if (m === 'night') { mat.map = emisTex; mat.color.set(0xffffff); }
    else { mat.map = null; mat.color.set(0x606c7c); }
    mat.needsUpdate = true;
  };
  applyMode(viewer.mode);
  viewer.modeHooks.push(applyMode);
  const mesh = new THREE.Mesh(mergeGeometries(geos, false), mat);
  mesh.castShadow = mesh.receiveShadow = false;
  viewer.scene.add(mesh);
  return mesh;
}

// deterministic rng
function rng(seed) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32; }

// ---------- canvas-generated leaf cluster sprite ----------
function makeLeafTexture() {
  const S = 256, cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, S, S);
  const rand = rng(777);
  const leaves = 210;
  for (let i = 0; i < leaves; i++) {
    const t = Math.sqrt(rand());
    const r = t * 112;                       // denser center
    const a = rand() * Math.PI * 2;
    const x = S / 2 + Math.cos(a) * r, y = S / 2 + Math.sin(a) * r * 0.94;
    const hue = 92 + rand() * 36;
    const light = 22 + rand() * 20 + (1 - t) * 6; // brighter core
    g.save();
    g.translate(x, y);
    g.rotate(rand() * Math.PI * 2);
    g.fillStyle = `hsl(${hue},${44 + rand() * 22}%,${light}%)`;
    g.beginPath();
    const w = 7 + rand() * 12, h = 3.4 + rand() * 4.6;
    g.ellipse(0, 0, w, h, 0, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function makeGlowTexture() {
  const S = 128, cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  const gr = g.createRadialGradient(S / 2, S / 2, 2, S / 2, S / 2, S / 2);
  gr.addColorStop(0, 'rgba(255,216,150,0.55)');
  gr.addColorStop(0.4, 'rgba(255,205,130,0.22)');
  gr.addColorStop(1, 'rgba(255,200,120,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------- tree geometry (canopy quads on ellipsoid shell, spherical normals) ----------
function makeTreeGeometries(seed) {
  const rand = rng(seed);
  const canopyParts = [];
  const CY = 4.4;                       // canopy center height
  const RX = 2.0, RY = 1.55, RZ = 2.0;  // canopy ellipsoid radii
  const quads = 14;
  for (let i = 0; i < quads; i++) {
    const size = 2.3 + rand() * 1.3;
    const q = new THREE.PlaneGeometry(size, size);
    // random point on ellipsoid shell (biased outward)
    const th = Math.acos(2 * rand() - 1), ph = rand() * Math.PI * 2;
    const k = 0.35 + 0.65 * rand();
    const px = Math.sin(th) * Math.cos(ph) * RX * k;
    const py = Math.cos(th) * RY * k * 0.9;
    const pz = Math.sin(th) * Math.sin(ph) * RZ * k;
    const m = new THREE.Matrix4()
      .makeRotationFromEuler(new THREE.Euler(rand() * Math.PI, rand() * Math.PI, rand() * Math.PI))
      .setPosition(px, CY + py, pz);
    q.applyMatrix4(m);
    // spherical normals -> soft ball-like shading
    const pos = q.attributes.position, nor = q.attributes.normal;
    const v = new THREE.Vector3();
    for (let j = 0; j < pos.count; j++) {
      v.fromBufferAttribute(pos, j).sub(new THREE.Vector3(0, CY, 0)).normalize();
      nor.setXYZ(j, v.x, v.y, v.z);
    }
    canopyParts.push(q);
  }
  const canopy = mergeGeometries(canopyParts, false);

  const trunkParts = [];
  const trunk = new THREE.CylinderGeometry(0.13, 0.22, 3.2, 7);
  trunk.translate(0, 1.6, 0);
  trunkParts.push(trunk);
  const branch = new THREE.CylinderGeometry(0.07, 0.11, 1.6, 5);
  branch.translate(0, 0.8, 0);
  branch.applyMatrix4(new THREE.Matrix4().makeRotationZ(0.6).setPosition(0.25, 2.6, 0.1));
  trunkParts.push(branch);
  return { canopy, trunk: mergeGeometries(trunkParts, false) };
}

export async function buildStreetscape(viewer, def) {
  const { n, pitch, lot, street, median: MEDIAN = 5, sidewalk: SIDEWALK = 5 } = def;
  const plateW = pitch - street - 2 * SIDEWALK;      // building lot plate width (incl. nothing)
  const walkPlate = pitch - street;                  // full plate incl. sidewalks
  const half = (street - MEDIAN) / 2;                // one roadway width
  const B = i => i * pitch;                          // block center
  const S = [];                                      // street center lines (both axes)
  for (let i = -1; i < n; i++) S.push(B(i) + pitch / 2);
  const cityMin = -pitch / 2 - street / 2, cityMax = B(n - 1) + pitch / 2 + street / 2;
  const center = (cityMin + cityMax) / 2;

  const [asA, asN, grA, grN] = await Promise.all([
    loadTex('textures/street/asphalt.png', true), loadTex('textures/street/asphalt_n.png'),
    loadTex('textures/street/grass.png', true), loadTex('textures/street/grass_n.png'),
  ]);

  const group = new THREE.Group();
  group.name = 'streetscape';

  // ---- base asphalt covering all roadways (reaches past the skyline ring;
  // fog + the distant-city silhouette hide the far edge) ----
  const EXT = 2500;
  const baseSize = (cityMax - cityMin) + EXT * 2;
  const baseTex = asA.clone(); baseTex.repeat.set(baseSize / 9, baseSize / 9); baseTex.needsUpdate = true;
  const baseNTex = asN.clone(); baseNTex.repeat.copy(baseTex.repeat); baseNTex.needsUpdate = true;
  const base = new THREE.Mesh(
    new THREE.PlaneGeometry(baseSize, baseSize).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ map: baseTex, normalMap: baseNTex, roughness: 0.96, metalness: 0 })
  );
  base.position.set(center, 0, center);
  base.receiveShadow = true;
  group.add(base);

  // ---- sidewalk/plaza plates per block (raised, curb via box sides) ----
  {
    const plates = [];
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const g = new THREE.BoxGeometry(walkPlate, 0.26, walkPlate);
      const uv = g.attributes.uv;
      for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) * walkPlate / 4.5, uv.getY(k) * walkPlate / 4.5);
      g.translate(B(i), 0.13 - 0.02, B(j));
      plates.push(g);
    }
    const plateTex = asA.clone(); plateTex.needsUpdate = true;
    const m = new THREE.Mesh(
      mergeGeometries(plates, false),
      new THREE.MeshStandardMaterial({ map: plateTex, normalMap: asN, color: 0xb9bab6, roughness: 0.95 })
    );
    m.receiveShadow = true; m.castShadow = false;
    group.add(m);
  }

  const zebraDepth = 3.2, zebraGap = 1.4;           // crossing band + clearance from corner
  const inter = street / 2;                          // intersection half-size
  const medStop = inter + zebraGap + zebraDepth + 1; // median/dash stop distance from street crossing center

  // ---- green medians (boxes) ----
  {
    const boxes = [];
    const segLen = pitch - 2 * medStop;
    for (const axis of ['x', 'z']) {
      for (const s of S) {                            // street line coordinate
        for (let i = 0; i < n; i++) {                 // segment per block span
          const c = B(i);
          const g = new THREE.BoxGeometry(axis === 'x' ? segLen : MEDIAN, 0.3, axis === 'x' ? MEDIAN : segLen);
          const uv = g.attributes.uv;
          for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) * segLen / 3, uv.getY(k) * MEDIAN / 3);
          g.translate(axis === 'x' ? c : s, 0.15 - 0.02, axis === 'x' ? s : c);
          boxes.push(g);
        }
      }
    }
    const m = new THREE.Mesh(
      mergeGeometries(boxes, false),
      new THREE.MeshStandardMaterial({ map: grA, normalMap: grN, roughness: 1 })
    );
    m.receiveShadow = true;
    group.add(m);
  }

  // ---- white paint: zebra stripes + lane dashes ----
  {
    const paint = [];
    const stripe = (w, d, x, z) => {                 // w along X, d along Z
      const g = new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2);
      g.translate(x, 0.02, z);
      paint.push(g);
    };
    for (const sx of S) for (const sz of S) {
      // four zebra bands around intersection (sx, sz)
      for (const side of [-1, 1]) {
        const off = inter + zebraGap + zebraDepth / 2;
        // approaches along X (vehicles travel X): stripes long in X, repeated across Z
        for (let zpos = -street / 2 + 0.8; zpos <= street / 2 - 0.8; zpos += 1.0)
          stripe(zebraDepth, 0.45, sx + side * off, sz + zpos);
        // approaches along Z: stripes long in Z, repeated across X
        for (let xpos = -street / 2 + 0.8; xpos <= street / 2 - 0.8; xpos += 1.0)
          stripe(0.45, zebraDepth, sx + xpos, sz + side * off);
      }
    }
    // lane dashes at the middle of each roadway half
    const dashLen = 3, dashPitch = 9;
    for (const axis of ['x', 'z']) {
      for (const s of S) for (let i = 0; i < n; i++) {
        const c = B(i), lo = c - pitch / 2 + medStop, hi = c + pitch / 2 - medStop;
        for (const lane of [-1, 1]) {
          const lz = s + lane * (MEDIAN / 2 + half / 2);
          for (let p = lo + 2; p + dashLen < hi - 2; p += dashPitch) {
            if (axis === 'x') stripe(dashLen, 0.16, p + dashLen / 2, lz);
            else stripe(0.16, dashLen, lz, p + dashLen / 2);
          }
        }
      }
    }
    const m = new THREE.Mesh(
      mergeGeometries(paint, false),
      new THREE.MeshStandardMaterial({ color: 0xe8e8e2, roughness: 0.62, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })
    );
    m.receiveShadow = true;
    group.add(m);
  }

  // ---- trees (two instanced meshes share the transform list) ----
  const rand = rng(def.seed || 4242);
  const treeXf = [];
  const addTree = (x, z) => {
    const s = 0.8 + rand() * 0.55;
    const m = new THREE.Matrix4()
      .makeRotationY(rand() * Math.PI * 2)
      .multiply(new THREE.Matrix4().makeRotationX((rand() - 0.5) * 0.06))
      .premultiply(new THREE.Matrix4().makeScale(s, s * (0.9 + rand() * 0.25), s));
    m.setPosition(x, 0.11, z);
    treeXf.push(m);
  };
  {
    const segLen = pitch - 2 * medStop;
    // median trees
    for (const axis of ['x', 'z']) for (const s of S) for (let i = 0; i < n; i++) {
      const c = B(i);
      for (let t = -segLen / 2 + 4; t <= segLen / 2 - 4; t += 10.5) {
        if (rand() < 0.18) continue;
        const jitter = (rand() - 0.5) * 1.2;
        if (axis === 'x') addTree(c + t + jitter, s + (rand() - 0.5) * 0.8);
        else addTree(s + (rand() - 0.5) * 0.8, c + t + jitter);
      }
    }
    // sidewalk trees along each block edge (1.4m in from curb)
    const edge = walkPlate / 2 - 1.4;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const cx = B(i), cz = B(j);
      for (let t = -edge + 7; t <= edge - 7; t += 15) {
        if (rand() < 0.3) continue;
        addTree(cx + t, cz - edge); addTree(cx + t, cz + edge);
        addTree(cx - edge, cz + t); addTree(cx + edge, cz + t);
      }
    }
  }
  const leafTex = makeLeafTexture();
  const { canopy, trunk } = makeTreeGeometries(1234);
  const leafMat = new THREE.MeshStandardMaterial({
    map: leafTex, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.9, metalness: 0,
  });
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4f3b28, roughness: 1 });
  const canopyIM = new THREE.InstancedMesh(canopy, leafMat, treeXf.length);
  const trunkIM = new THREE.InstancedMesh(trunk, trunkMat, treeXf.length);
  treeXf.forEach((m, i) => { canopyIM.setMatrixAt(i, m); trunkIM.setMatrixAt(i, m); });
  canopyIM.castShadow = true;
  canopyIM.customDepthMaterial = new THREE.MeshDepthMaterial({
    depthPacking: THREE.RGBADepthPacking, map: leafTex, alphaTest: 0.45,
  });
  trunkIM.castShadow = true;
  group.add(canopyIM, trunkIM);

  // ---- street lamps ----
  const lampXf = [];
  {
    const off = street / 2 + 0.6;                    // just inside the curb, on the plate
    for (const axis of ['x', 'z']) for (const s of S) for (let i = 0; i < n; i++) {
      const c = B(i);
      for (const [t, side] of [[-pitch / 3, -1], [0, 1], [pitch / 3, -1]]) {
        const m = new THREE.Matrix4().makeRotationY(axis === 'x' ? (side > 0 ? Math.PI : 0) : (side > 0 ? -Math.PI / 2 : Math.PI / 2));
        if (axis === 'x') m.setPosition(c + t, 0.11, s + side * off);
        else m.setPosition(s + side * off, 0.11, c + t);
        lampXf.push(m);
      }
    }
  }
  const poleParts = [];
  {
    const pole = new THREE.CylinderGeometry(0.06, 0.09, 6.4, 6); pole.translate(0, 3.2, 0);
    const arm = new THREE.CylinderGeometry(0.045, 0.045, 2.2, 5);
    arm.rotateX(Math.PI / 2 - 0.18); arm.translate(0, 6.25, -1.0);
    poleParts.push(pole, arm);
  }
  const headGeo = new THREE.BoxGeometry(0.22, 0.12, 0.62); headGeo.translate(0, 6.55, -2.0);
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x3b3f45, roughness: 0.6, metalness: 0.6 });
  const headMat = new THREE.MeshStandardMaterial({ color: 0x8c8f94, roughness: 0.4, emissive: 0xffd9a0, emissiveIntensity: 0 });
  const poleIM = new THREE.InstancedMesh(mergeGeometries(poleParts, false), poleMat, lampXf.length);
  const headIM = new THREE.InstancedMesh(headGeo, headMat, lampXf.length);
  lampXf.forEach((m, i) => { poleIM.setMatrixAt(i, m); headIM.setMatrixAt(i, m); });
  poleIM.castShadow = true;
  group.add(poleIM, headIM);

  // ground glow pools under lamps (night only)
  const glowGeos = [];
  const gv = new THREE.Vector3(), gq = new THREE.Quaternion(), gs = new THREE.Vector3();
  const lampHeads = [];                              // world pos of each lamp head
  for (const m of lampXf) {
    m.decompose(gv, gq, gs);
    const local = new THREE.Vector3(0, 0, -2.0).applyQuaternion(gq);
    lampHeads.push(new THREE.Vector3(gv.x + local.x, 6.4, gv.z + local.z));
    const g = new THREE.PlaneGeometry(13, 13).rotateX(-Math.PI / 2);
    g.translate(gv.x + local.x, 0.18, gv.z + local.z);
    glowGeos.push(g);
  }
  const glow = new THREE.Mesh(
    mergeGeometries(glowGeos, false),
    new THREE.MeshBasicMaterial({ map: makeGlowTexture(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  glow.visible = false;
  group.add(glow);

  // real point lights on the few lamps nearest to the hero anchors (night only)
  const nightLights = new THREE.Group();
  nightLights.visible = false;
  for (const [ax, az] of def.lightAnchors || []) {
    const sorted = lampHeads.map(p => ({ p, d: (p.x - ax) ** 2 + (p.z - az) ** 2 })).sort((a, b) => a.d - b.d).slice(0, 4);
    for (const { p } of sorted) {
      const pl = new THREE.PointLight(0xffd9a0, 900, 42, 2);
      pl.position.copy(p);
      nightLights.add(pl);
    }
  }
  group.add(nightLights);

  viewer.scene.add(group);

  const setMode = mode => {
    const night = mode === 'night';
    headMat.emissiveIntensity = night ? 3.5 : 0;
    glow.visible = night;
    nightLights.visible = night;
  };
  viewer.modeHooks.push(setMode);
  setMode(viewer.mode);
  return { group, setMode };
}
