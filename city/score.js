// Collectible spider-beacons: pick them up across rooftops and canyons.
// Each is worth `value` points; beacons are aim-targetable (their AABBs join
// the player's swing/zip target list) so every one is reachable by design.
import * as THREE from 'three';

function makeBeaconTexture() {
  const cv = document.createElement('canvas');
  cv.width = 32; cv.height = 256;
  const g = cv.getContext('2d');
  const gr = g.createLinearGradient(0, 256, 0, 0);
  gr.addColorStop(0, 'rgba(255,80,90,0.85)');
  gr.addColorStop(0.35, 'rgba(255,90,100,0.35)');
  gr.addColorStop(1, 'rgba(255,120,130,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 32, 256);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class ScoreSystem {
  constructor(viewer, spots, opts = {}) {
    this.viewer = viewer;
    this.radius = opts.radius ?? 3.5;
    this.value = opts.value ?? 10;
    this.boxes = opts.boxes || null;   // player's target/collider list (orbs join it)
    this.AABB = opts.AABB;
    this.score = 0;
    this.max = spots.length * this.value;
    this.collected = 0;
    this.total = spots.length;
    this.startTime = null;
    this.endTime = null;
    this.onChange = opts.onChange || (() => {});
    this._t = 0;

    const beaconTex = makeBeaconTexture();
    const coreGeo = new THREE.IcosahedronGeometry(0.55, 1);
    const ringGeo = new THREE.TorusGeometry(0.95, 0.06, 8, 32);
    const beaconGeo = new THREE.CylinderGeometry(0.55, 0.55, 46, 10, 1, true).translate(0, 23, 0);

    this.orbs = spots.map((s, i) => {
      const group = new THREE.Group();
      const core = new THREE.Mesh(coreGeo, new THREE.MeshStandardMaterial({
        color: 0x5a0d16, emissive: 0xff3040, emissiveIntensity: 2.4, roughness: 0.35,
      }));
      const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xffb7c0, transparent: true, opacity: 0.9 }));
      const beacon = new THREE.Mesh(beaconGeo, new THREE.MeshBasicMaterial({
        map: beaconTex, transparent: true, blending: THREE.AdditiveBlending,
        depthWrite: false, side: THREE.DoubleSide,
      }));
      group.add(core, ring, beacon);
      group.position.set(s[0], s[1], s[2]);
      viewer.scene.add(group);
      const orb = { group, core, ring, base: s[1], phase: i * 1.7, taken: false, box: null };
      if (this.boxes && this.AABB) {
        orb.box = new this.AABB(s[0] - 0.8, s[1] - 0.8, s[2] - 0.8, s[0] + 0.8, s[1] + 0.8, s[2] + 0.8);
        this.boxes.push(orb.box);
      }
      return orb;
    });

    this._audio = null;
  }

  _beep(seq) {
    try {
      this._audio = this._audio || new (window.AudioContext || window.webkitAudioContext)();
      const ctx = this._audio;
      let t = ctx.currentTime;
      for (const [freq, dur] of seq) {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'triangle'; o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.18, t + 0.015);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(g).connect(ctx.destination);
        o.start(t); o.stop(t + dur + 0.02);
        t += dur * 0.7;
      }
    } catch (e) { /* audio optional */ }
  }

  update(playerPos, dt) {
    this._t += dt;
    const r2 = this.radius * this.radius;
    for (const o of this.orbs) {
      if (o.taken) continue;
      o.group.position.y = o.base + Math.sin(this._t * 2 + o.phase) * 0.5;
      o.core.rotation.y += dt * 2.4;
      o.ring.rotation.x = Math.PI / 2;
      o.ring.rotation.z += dt * 1.2;
      const p = o.group.position;
      const dx = playerPos.x - p.x, dy = (playerPos.y + 1) - p.y, dz = playerPos.z - p.z;
      if (dx * dx + dy * dy + dz * dz < r2) this._collect(o);
    }
  }

  _collect(o) {
    o.taken = true;
    o.group.visible = false;
    if (o.box && this.boxes) {
      const i = this.boxes.indexOf(o.box);
      if (i >= 0) this.boxes.splice(i, 1);
    }
    this.collected++;
    this.score += this.value;
    if (this.startTime === null) this.startTime = performance.now();
    if (this.collected === this.total) {
      this.endTime = performance.now();
      this._beep([[660, 0.12], [880, 0.12], [1320, 0.28]]);
    } else {
      this._beep([[880, 0.09], [1320, 0.14]]);
    }
    this.onChange(this);
  }

  nearest(playerPos) {
    let d = Infinity;
    for (const o of this.orbs) {
      if (o.taken) continue;
      const p = o.group.position;
      const dd = Math.hypot(playerPos.x - p.x, playerPos.y - p.y, playerPos.z - p.z);
      if (dd < d) d = dd;
    }
    return d === Infinity ? null : d;
  }

  elapsed() {
    if (this.startTime === null) return null;
    const ms = (this.endTime ?? performance.now()) - this.startTime;
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
}

// all beacons sit ON buildings: quantile-sample rooftops from low to high
// (28–190m) with spatial spread — a natural difficulty ramp, no floaters.
export function makeSpots(instances, manifest, cityDef) {
  const cands = [];
  for (const it of instances) {
    const e = manifest.models[it.model];
    if (!e || e.kind !== 'house') continue;
    const h = e.bbox.max[1];
    cands.push({ x: it.pos[0], z: it.pos[2], top: it.pos[1] + h, h });
  }
  const mids = cands.filter(c => c.top >= 28 && c.top <= 190).sort((a, b) => a.h - b.h);
  const picked = [];
  const okSpacing = c => picked.every(p => Math.hypot(p.x - c.x, p.z - c.z) > 90);
  const COUNT = 10;
  for (let i = 0; i < COUNT && mids.length; i++) {
    const want = Math.round(i * (mids.length - 1) / (COUNT - 1));
    let chosen = null;
    for (let off = 0; off < mids.length && !chosen; off++) {
      for (const j of [want + off, want - off]) {
        if (chosen || j < 0 || j >= mids.length) continue;
        const c = mids[j];
        if (!picked.includes(c) && okSpacing(c)) chosen = c;
      }
    }
    if (chosen) picked.push(chosen);
  }
  // fill up with relaxed spacing if the grid was too tight
  for (const c of mids) {
    if (picked.length >= COUNT) break;
    if (!picked.includes(c) && picked.every(p => Math.hypot(p.x - c.x, p.z - c.z) > 60)) picked.push(c);
  }
  return picked.map(p => [p.x, p.top + 2.2, p.z]);
}
