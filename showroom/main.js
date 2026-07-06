import { Viewer, makePanel, applyUrlOverrides } from '../shared/app.js';
import * as THREE from 'three';

const viewer = new Viewer(document.body, { shadowSize: 260, fov: 50 });
await viewer.loadTextures();
const manifest = await (await fetch(new URL('../shared/models.json', import.meta.url))).json();
const names = Object.keys(manifest.models);
await viewer.loadModels(names);

// concrete display pad
viewer.addGround(3000, 0x33363a);
const pad = new THREE.Mesh(
  new THREE.CylinderGeometry(95, 100, 0.4, 64),
  new THREE.MeshStandardMaterial({ color: 0x4a4e54, roughness: 0.9 })
);
pad.position.y = -0.15;
pad.receiveShadow = true;
viewer.scene.add(pad);

let current = null, autoRotate = true;
function show(name, forceLod) {
  if (current) viewer.scene.remove(current);
  current = viewer.instantiate(name, [0, 0, 0], 0, forceLod);
  const e = manifest.models[name];
  const h = e.bbox.max[1] - e.bbox.min[1];
  const w = Math.max(e.bbox.max[0] - e.bbox.min[0], e.bbox.max[2] - e.bbox.min[2]);
  info.textContent = `尺寸 ${w.toFixed(0)}m × 高 ${h.toFixed(0)}m · LOD tris: ${e.tris.join(' / ')}`;
  // frame camera to model size (fit height + width with margin)
  const fovR = viewer.camera.fov * Math.PI / 360;
  const d = Math.max((h * 0.62) / Math.tan(fovR), w * 1.05) * 1.35;
  viewer.camera.position.set(d * 0.7, Math.max(h * 0.55, Math.min(d * 0.4, 14)), d * 0.7);
  viewer.controls.target.set(0, h * 0.46, 0);
}

const panel = makePanel('Modern Buildings · 单体展厅');
const sel = document.createElement('select');
for (const n of names) { const o = document.createElement('option'); o.value = n; o.textContent = `${n} (${manifest.models[n].kind})`; sel.appendChild(o); }
const lodSel = document.createElement('select');
for (const [v, l] of [[-1, 'LOD 自动'], [0, 'LOD0'], [1, 'LOD1'], [2, 'LOD2']]) { const o = document.createElement('option'); o.value = v; o.textContent = l; lodSel.appendChild(o); }
const dayBtn = document.createElement('button'); dayBtn.textContent = '☀️/🌙';
const rotBtn = document.createElement('button'); rotBtn.textContent = '⟳ 旋转';
panel.append(sel, lodSel, dayBtn, rotBtn);
const info = document.createElement('div');
info.style.cssText = 'margin-top:6px;opacity:.75;font-size:11px';
const stats = document.createElement('div');
stats.style.cssText = 'opacity:.55;font-size:11px';
panel.append(info, stats);

sel.onchange = () => show(sel.value, Number(lodSel.value));
lodSel.onchange = () => show(sel.value, Number(lodSel.value));
dayBtn.onclick = () => viewer.setMode(viewer.mode === 'day' ? 'night' : 'day');
rotBtn.onclick = () => autoRotate = !autoRotate;

viewer.setMode('day');
const q = applyUrlOverrides(viewer);
const first = q.get('model') || 'h11';
sel.value = first;
show(first, Number(q.get('lod') ?? -1));
if (q.get('lod')) lodSel.value = q.get('lod');

viewer.start(() => {
  if (current && autoRotate) current.rotation.y += 0.003;
  stats.textContent = viewer.stats();
});
document.getElementById('loading').style.opacity = '0';
setTimeout(() => document.getElementById('loading').remove(), 500);
