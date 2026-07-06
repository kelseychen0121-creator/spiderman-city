import { Viewer, makePanel, applyUrlOverrides } from '../shared/app.js';
import { buildStreetscape, buildSkyline } from '../shared/streets.js';
import { PlayerController, AABB } from './play.js';
import { ScoreSystem, makeSpots } from './score.js';
import { Sfx } from '../shared/audio.js';
import * as THREE from 'three';

// guard against double-boot (preview panels can re-inject the module)
if (window.__cityBooted) throw new Error('city already booted');
window.__cityBooted = true;
for (const el of document.querySelectorAll('.city-panel')) el.remove();

const viewer = new Viewer(document.body, { shadowSize: 460 });
window.__viewer = viewer; // debug handle
const scene = await (await fetch('./scene.json')).json();

// aim sun/shadows at the city center
const c = scene.city;
const mid = ((c.n - 1) * c.pitch) / 2;
viewer.sunFocus.set(mid, 0, mid);

await viewer.loadTextures();
const names = [...new Set(scene.instances.map(i => i.model))];
await viewer.loadModels(names);

// buildings: instantiate + build SLICED AABB colliders that follow the real
// silhouette (tapering towers used to have huge invisible bounding boxes —
// web anchors could stick to empty air next to a spire)
const boxes = [];
const sliceCache = {};
function modelSlices(name) {
  if (sliceCache[name]) return sliceCache[name];
  const entry = viewer.manifest.models[name];
  const geo = viewer.models[name].lodMeshes[0].geometry;
  const posA = geo.attributes.position;
  const idx = geo.index;
  const minY = entry.bbox.min[1], maxY = entry.bbox.max[1];
  const H = Math.max(1e-3, maxY - minY);
  const n = Math.min(16, Math.max(1, Math.ceil(H / 12)));
  const sl = new Array(n).fill(null);
  const bin = (x, y, z) => {
    let k = Math.max(0, Math.min(n - 1, Math.floor((y - minY) / H * n)));
    const s = sl[k] || (sl[k] = { minX: x, maxX: x, minZ: z, maxZ: z });
    if (x < s.minX) s.minX = x; if (x > s.maxX) s.maxX = x;
    if (z < s.minZ) s.minZ = z; if (z > s.maxZ) s.maxZ = z;
  };
  // sample along triangle edges so tall low-poly walls fill every slice
  const va = new THREE.Vector3(), vb = new THREE.Vector3();
  const nTri = (idx ? idx.count : posA.count) / 3;
  for (let t = 0; t < nTri; t++) {
    for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
      const ia = idx ? idx.getX(t * 3 + a) : t * 3 + a;
      const ib = idx ? idx.getX(t * 3 + b) : t * 3 + b;
      va.fromBufferAttribute(posA, ia);
      vb.fromBufferAttribute(posA, ib);
      const steps = Math.max(1, Math.ceil(Math.abs(vb.y - va.y) / 6));
      for (let s = 0; s <= steps; s++) {
        const f = s / steps;
        bin(va.x + (vb.x - va.x) * f, va.y + (vb.y - va.y) * f, va.z + (vb.z - va.z) * f);
      }
    }
  }
  const out = [];
  for (let k = 0; k < n; k++) {
    if (!sl[k]) continue;
    out.push({ y0: minY + k * H / n, y1: minY + (k + 1) * H / n, ...sl[k] });
  }
  if (out.length) out[out.length - 1].isTop = true;
  sliceCache[name] = out;
  return out;
}

for (const it of scene.instances) {
  const obj = viewer.instantiate(it.model, it.pos, it.rotY || 0);
  const e = viewer.manifest.models[it.model];
  if (e.kind !== 'house') continue;
  // the placed LOD0 mesh — precise aim raycasts hit REAL geometry, never box air
  const aimMesh = obj.isLOD ? obj.levels[0].object : obj;
  const cy = Math.cos(it.rotY || 0), sy = Math.sin(it.rotY || 0);
  const built = [];
  for (const s of modelSlices(it.model)) {
    const corners = [[s.minX, s.minZ], [s.minX, s.maxZ], [s.maxX, s.minZ], [s.maxX, s.maxZ]];
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const [x, z] of corners) {
      const rx = x * cy + z * sy, rz = -x * sy + z * cy;
      minX = Math.min(minX, rx); maxX = Math.max(maxX, rx);
      minZ = Math.min(minZ, rz); maxZ = Math.max(maxZ, rz);
    }
    const box = new AABB(
      it.pos[0] + minX, it.pos[1] + s.y0, it.pos[2] + minZ,
      it.pos[0] + maxX, it.pos[1] + s.y1, it.pos[2] + maxZ
    );
    box.isTop = !!s.isTop;
    box.mesh = aimMesh;
    built.push(box);
    boxes.push(box);
  }
  const topBox = built[built.length - 1];
  for (const b of built) b.top = topBox; // zip roof-snap targets the building's real top
}
viewer.scene.updateMatrixWorld(true); // bake transforms for aim raycasts

await buildStreetscape(viewer, scene.city);
buildSkyline(viewer, scene.city, viewer.materials.houses); // distant hazy skyline hides the map edge

// ground height: raised sidewalk plates on blocks, street level elsewhere
const plateHalf = (c.pitch - c.street) / 2;
const groundHeightAt = (x, z) => {
  const cx = Math.round(x / c.pitch) * c.pitch, cz = Math.round(z / c.pitch) * c.pitch;
  if (cx < -1 || cx > (c.n - 1) * c.pitch + 1 || cz < -1 || cz > (c.n - 1) * c.pitch + 1) return 0;
  return (Math.abs(x - cx) < plateHalf && Math.abs(z - cz) < plateHalf) ? 0.24 : 0;
};

// playable Spider-Man: procedural segmented hero on the native Mixamo skeleton —
// rigid parts per bone: no skinning, no mesh tearing, clips play with zero retarget
const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
const rigGltf = await new Promise((res, rej) => new GLTFLoader().load(
  new URL('../shared/models/hero_rig.glb', import.meta.url).href + '?v=3', res, undefined, rej));
const rigMeta = await (await fetch(new URL('../shared/models/hero_rig.json', import.meta.url).href + '?v=3')).json();
// the GLB carries only the skeleton + clips — attach the rigid-segment body now
const { buildProcSpidey } = await import('../shared/spidey-proc.js');
buildProcSpidey(rigGltf.scene);
rigGltf.scene.traverse(o => {
  if (o.isMesh) { o.frustumCulled = false; o.castShadow = true; o.receiveShadow = true; }
});
// the rig lives in the FBX's centimetre space — recreate the bake normalization
rigGltf.scene.position.set(rigMeta.offset.x, rigMeta.offset.y, rigMeta.offset.z);
const rigWrap = new THREE.Group();
rigWrap.add(rigGltf.scene);
rigWrap.scale.setScalar(rigMeta.scale);
const spidey = new THREE.Group();

// sound effects (decoded on first click — pointer-lock gesture unlocks audio)
const AURL = p => new URL(`../shared/audio/${p}`, import.meta.url).href;
const sfx = new Sfx({
  shoot: AURL('web_shoot.mp3'),      // 发射蛛丝
  wind: AURL('swing_wind.mp3'),      // 荡绳（循环，音量随速度）
  speedwind: AURL('speed_wind.mp3'), // 全局风声（循环，音量+音调纯随速度）
  zip: AURL('zip_whoosh.mp3'),       // 右键弹射
  jump: AURL('jump.mp3'),            // 起跳
  land: AURL('land.mp3'),            // 落地
});

const player = new PlayerController(viewer, {
  spawn: scene.spawn || [55, 0.02, 55],
  boxes,
  visual: spidey,
  groundHeightAt,
  sfx,
  anims: { group: rigWrap, clips: rigGltf.animations, meta: rigMeta },
  bounds: { min: -c.pitch / 2 - c.street / 2 - 35, max: (c.n - 1) * c.pitch + c.pitch / 2 + c.street / 2 + 35 },
});
viewer.controls.enabled = false; // player owns the camera
window.__player = player; // debug/test handle

// ---- score: collect 10 spider-beacons (7 rooftops + 3 canyon), 10 pts each, max 100 ----
const scorePill = document.createElement('div');
scorePill.id = 'scorePill';
scorePill.textContent = '🕷️ 0 / 100';
document.body.appendChild(scorePill);
const banner = document.createElement('div');
banner.id = 'winBanner';
banner.classList.add('hidden');
document.body.appendChild(banner);

const spots = makeSpots(scene.instances, viewer.manifest, c);
const scoreSys = new ScoreSystem(viewer, spots, {
  boxes, AABB, radius: 3.5, value: 10,
  onChange: s => {
    scorePill.textContent = `🕷️ ${s.score} / ${s.max}`;
    scorePill.classList.remove('pop');
    void scorePill.offsetWidth; // restart animation
    scorePill.classList.add('pop');
    if (s.collected === s.total) {
      banner.innerHTML = `🕷️ <b>满分 ${s.max} / ${s.max}！</b><br>集齐全城 ${s.total} 个蜘蛛信标 · 用时 ${s.elapsed()}<br><span style="opacity:.7;font-size:13px">按 R 回出生点继续闲逛</span>`;
      banner.classList.remove('hidden');
    }
  },
});
window.__score = scoreSys;

viewer.setMode('day');

// ---- HUD ----
const panel = makePanel('蜘蛛侠 · 密集街区');
const row = document.createElement('div');
panel.appendChild(row);
const addBtn = (label, fn) => { const b = document.createElement('button'); b.textContent = label; b.onclick = fn; row.appendChild(b); return b; };
addBtn('☀️ 白天', () => viewer.setMode('day'));
addBtn('🌙 黑夜', () => viewer.setMode('night'));
const help = document.createElement('div');
help.style.cssText = 'margin-top:6px;opacity:.8;font-size:11px;line-height:1.7';
help.innerHTML = '按住<b>左键</b>射丝摆荡（朝准星方向甩）· 松开抛出<br><b>右键</b> Zip 弹射：瞄楼顶边缘可直接上楼顶<br>摆荡中 <b>W</b> 收绳爬升 · A/D 摆弧 · <b>空格</b>跳 · <b>R</b> 重生<br>滚轮调相机距离<br><span style="color:#ff9aa5">收集 10 个楼顶蜘蛛信标（绿球可瞄准）· 从矮楼开始！</span>';
panel.appendChild(help);
const stats = document.createElement('div');
stats.style.cssText = 'margin-top:4px;opacity:.6;font-size:11px';
panel.appendChild(stats);

applyUrlOverrides(viewer);

let last = performance.now();
viewer.start(() => {
  const now = performance.now();
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  player.update(dt);
  scoreSys.update(player.pos, dt);
  if (scoreSys.collected < scoreSys.total) {
    const nd = scoreSys.nearest(player.pos);
    scorePill.textContent = `🕷️ ${scoreSys.score} / ${scoreSys.max}${nd ? ` · 最近信标 ${nd | 0}m` : ''}`;
  }
  stats.textContent = `${player.speed().toFixed(1)} m/s · ${viewer.stats()}`;
});
document.getElementById('loading').style.opacity = '0';
setTimeout(() => document.getElementById('loading').remove(), 500);
