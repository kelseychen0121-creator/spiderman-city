// Spider-Man web-swinging controller.
// Physics-first: real rigidbody + spring-rope pendulum at fixed 1/60 steps,
// with momentum-only "cheats" at key moments (attach floor speed, tangential
// boost, release bonus). Cheats add momentum, never teleport position.
import * as THREE from 'three';

const G = -20;                 // gravity (2x heavier than default — swing rhythm)
const MAX_SPEED = 42;          // global speed cap (calmer pacing)
const FIXED_DT = 1 / 60;

// swing tuning (from the design spec, re-paced)
const ROPE_SPRING = 90, ROPE_DAMPER = 9;
const ATTACH_LEN_RATIO = 0.8;
const ATTACH_HOP_VY = 4;
const ATTACH_MIN_SPEED = 10;
const TANGENT_BOOST = 14;
const AIR_CONTROL = 25;
const SIDE_FORCE = AIR_CONTROL * 1.3;
const REEL_SPEED = 10, MIN_ROPE = 3;
const RELEASE_MULT = 1.08, RELEASE_VY = 2.0;
const ROPE_MIN = 4, ROPE_MAX = 120;
const ANCHOR_MIN_ABOVE_GROUNDED = 4, ANCHOR_MIN_ABOVE_AIR = 1.5;
const SWING_STEER = 0.45;            // tangential boost blends toward camera forward

// zip
const ZIP_SPEED = 30, ZIP_TMIN = 0.25, ZIP_TMAX = 2.5, ZIP_OVERSHOOT = 1.4;

// locomotion
const RUN_SPEED = 8, RUN_ACCEL = 60, JUMP_VY = 9;

// camera
const CAM_DIST = 4.6, CAM_MIN = 2.4, CAM_MAX = 12;
const CAM_PIVOT_H = 2.1, CAM_LOOK_H = 2.3;
const FOV_BASE = 70, FOV_MAX = 78, FOV_V0 = 14, FOV_V1 = 38;
const CAM_RECOVER = 4;

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3(), _v5 = new THREE.Vector3();

class AABB {
  constructor(minX, minY, minZ, maxX, maxY, maxZ) {
    this.minX = minX; this.minY = minY; this.minZ = minZ;
    this.maxX = maxX; this.maxY = maxY; this.maxZ = maxZ;
  }
  // slab raycast; returns t or Infinity
  raycast(o, d, tMax) {
    let t0 = 0, t1 = tMax;
    for (const [mn, mx, oo, dd] of [
      [this.minX, this.maxX, o.x, d.x],
      [this.minY, this.maxY, o.y, d.y],
      [this.minZ, this.maxZ, o.z, d.z],
    ]) {
      if (Math.abs(dd) < 1e-9) { if (oo < mn || oo > mx) return Infinity; continue; }
      let ta = (mn - oo) / dd, tb = (mx - oo) / dd;
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
      if (t0 > t1) return Infinity;
    }
    return t0;
  }
}

export class PlayerController {
  constructor(viewer, opts) {
    this.viewer = viewer;
    this.camera = viewer.camera;
    this.scene = viewer.scene;
    this.spawn = new THREE.Vector3(...opts.spawn);
    this.groundHeightAt = opts.groundHeightAt || (() => 0);
    this.bounds = opts.bounds || null; // {min, max} soft city boundary (xz)

    // building colliders / swingables
    this.boxes = opts.boxes; // AABB[]

    // rigidbody state (capsule: foot point + radius/height)
    this.pos = this.spawn.clone();
    this.prevPos = this.pos.clone();
    this.vel = new THREE.Vector3();
    this.radius = 0.45;
    this.height = 1.65;
    this.grounded = false;

    // rope state
    this.swinging = false;
    this.anchor = new THREE.Vector3();
    this.ropeLen = 0;
    this._zipT = 0;            // zip-flight window: speed cap relaxed so the ballistic solve lands

    // input
    this.keys = {};
    this.yaw = -2.4; this.pitch = -0.06;
    this.camDist = CAM_DIST; this.camDistCur = CAM_DIST;
    this.locked = false;

    // visual child (model faces +Z at rotY=0)
    this.visual = opts.visual;
    this.visual.rotation.order = 'YXZ';
    this.scene.add(this.visual);
    this.visYaw = this.yaw + Math.PI;
    this.visTilt = 0;
    // optional pose variants: arms down on ground, arms spread in the air
    this.poseGround = opts.poseGround || null;
    this.poseAir = opts.poseAir || null;
    // skeletal animation rig (retargeted Mixamo clips): fly/climb/jump/pose/throw
    this.anim = null;
    if (opts.anims) {
      const { group, clips, meta } = opts.anims;
      this.anim = { group, meta: meta.anims, minY: meta.minY };
      group.visible = false;
      this.visual.add(group);
      this._mixer = new THREE.AnimationMixer(group);
      this._actions = {};
      for (const c of clips) {
        // the export baked the Hips.position track to all-zeros (mixamo keeps hip
        // height in a parent node), which collapses the skeleton to the origin —
        // strip it so the hips hold their correct bind height, rotations still drive
        c.tracks = c.tracks.filter(t => !t.name.endsWith('Hips.position'));
        const a = this._mixer.clipAction(c);
        if (meta.anims[c.name] && meta.anims[c.name].loop) a.setLoop(THREE.LoopRepeat, Infinity);
        else { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
        this._actions[c.name] = a;
      }
      this._curAnim = null;
      this._animFade = 0;
      // foot bones for live ground-planting (robust vs the precomputed table)
      this._footBones = [];
      for (const bn of ['mixamorigLeftToe_End', 'mixamorigRightToe_End', 'mixamorigLeftFoot', 'mixamorigRightFoot']) {
        group.traverse(o => { if (o.name === bn) this._footBones.push(o); });
      }
      this._footTmp = new THREE.Vector3();
    }
    this._throwT = 0;         // web-shoot animation window
    this._animOneShot = null; // {name, t, dur}
    this._animLift = 0;       // smoothed ground-clip compensation
    this._animLiftTarget = 0;
    this._airTime = 0;        // idle/air switch hysteresis

    this._makeMarkers();
    this._bind(viewer.renderer.domElement);
    this.aimHit = null;
    this._acc = 0;
    this._t = 0;
    this._rp = new THREE.Vector3(); // interpolated render position (must not alias scratch vectors)
    this.sfx = opts.sfx || null;
    this._landCd = 0;               // landing-sound cooldown
  }

  // ---------- markers & rope visuals ----------
  _makeMarkers() {
    this.greenBall = new THREE.Mesh(
      new THREE.SphereGeometry(0.5, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0x39ff7a, transparent: true, opacity: 0.9 })
    );
    this.orangeBall = new THREE.Mesh(
      new THREE.SphereGeometry(0.42, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xff9430 })
    );
    this.greenBall.visible = this.orangeBall.visible = false;
    // rope as a thin cylinder stretched between hand and anchor
    this.ropeMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.03, 0.03, 1, 6, 1, true).translate(0, 0.5, 0), // pivot at base, +Y up
      new THREE.MeshBasicMaterial({ color: 0xf4f4f0 })
    );
    this.ropeMesh.visible = false;
    this.scene.add(this.greenBall, this.orangeBall, this.ropeMesh);
  }

  _handPos(out) { return out.copy(this.pos).add(_v3.set(0, 1.55, 0)); }

  // ---------- input ----------
  _bind(canvas) {
    this.canvas = canvas;
    canvas.addEventListener('click', () => {
      if (!this.locked) canvas.requestPointerLock();
      if (this.sfx) this.sfx.init(); // user gesture: unlock + decode audio
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      document.getElementById('lockHint')?.classList.toggle('hidden', this.locked);
    });
    addEventListener('mousemove', e => {
      if (!this.locked) return;
      this.yaw -= e.movementX * 0.0024;
      this.pitch -= e.movementY * 0.0022;
      this.pitch = THREE.MathUtils.clamp(this.pitch, -1.22, 1.48);
    });
    addEventListener('mousedown', e => {
      if (!this.locked) return;
      if (e.button === 0) this._tryAttach();
      else if (e.button === 2) this._tryZip();
    });
    addEventListener('mouseup', e => {
      if (!this.locked) return;
      if (e.button === 0 && this.swinging) this._release();
    });
    addEventListener('contextmenu', e => { if (this.locked) e.preventDefault(); });
    addEventListener('keydown', e => {
      this.keys[e.code] = true;
      if (e.code === 'KeyR') this.respawn();
      if (e.code === 'Space') e.preventDefault();
    });
    addEventListener('keyup', e => { this.keys[e.code] = false; });
    addEventListener('wheel', e => {
      this.camDist = THREE.MathUtils.clamp(this.camDist + Math.sign(e.deltaY) * 0.8, CAM_MIN, CAM_MAX);
    }, { passive: true });
  }

  respawn() {
    this.pos.copy(this.spawn); this.prevPos.copy(this.pos);
    this.vel.set(0, 0, 0);
    if (this._camAnchor) this._camAnchor.copy(this.pos);
    this._detach();
  }

  // ---------- aiming ----------
  // center ray first, then two assist rings (4% / 8% screen height, 6 dirs each).
  // Two phases: slice-box broadphase, then a PRECISE raycast against the real
  // building mesh — anchors can only land on actual geometry, never box air.
  _aim() {
    const minAbove = this.grounded ? ANCHOR_MIN_ABOVE_GROUNDED : ANCHOR_MIN_ABOVE_AIR;
    const samples = [[0, 0]];
    for (const r of [0.08, 0.16]) // NDC (screen height 4% / 8% doubled to NDC units)
      for (let k = 0; k < 6; k++) {
        const a = k / 6 * Math.PI * 2;
        samples.push([Math.cos(a) * r * 0.66, Math.sin(a) * r]); // x scaled by aspect-ish
      }
    const origin = this.camera.position;
    if (!this._ray) { this._ray = new THREE.Raycaster(); this._ray.far = 240; }
    for (const [nx, ny] of samples) {
      _v.set(nx, ny, 0.5).unproject(this.camera).sub(origin).normalize();
      // broadphase: every slice box the ray crosses, nearest first
      const cands = [];
      for (const b of this.boxes) {
        const t = b.raycast(origin, _v, 240);
        if (t < 240) cands.push({ t, b });
      }
      if (!cands.length) continue;
      cands.sort((a, b) => a.t - b.t);
      // narrow phase: precise mesh intersection (beacon boxes accept the slab hit)
      let bestT = Infinity, bestHit = null, bestBox = null;
      const tested = new Set();
      for (const c of cands) {
        if (c.t > bestT) break;
        if (!c.b.mesh) {
          if (c.t < bestT) { bestT = c.t; bestHit = origin.clone().addScaledVector(_v, c.t - 0.05); bestBox = c.b; }
          continue;
        }
        if (tested.has(c.b.mesh)) continue;
        tested.add(c.b.mesh);
        this._ray.set(origin, _v);
        const ints = this._ray.intersectObject(c.b.mesh, false);
        if (ints.length && ints[0].distance < bestT) {
          bestT = ints[0].distance;
          bestHit = ints[0].point;
          bestBox = c.b;
        }
      }
      if (!bestHit) continue;
      const d = bestHit.distanceTo(this.pos);
      if (d < ROPE_MIN || d > ROPE_MAX) continue;
      if (bestHit.y < this.pos.y + minAbove) continue;
      return { hit: bestHit, box: bestBox };
    }
    return null;
  }

  // ---------- rope actions ----------
  _tryAttach() {
    const hit = this.aimHit;
    if (!hit) return;
    this.anchor.copy(hit);
    const dist = this.pos.distanceTo(this.anchor);
    this.ropeLen = Math.max(MIN_ROPE, dist * ATTACH_LEN_RATIO);  // free lift
    this.swinging = true;

    if (this.grounded) this.vel.y = Math.max(this.vel.y, ATTACH_HOP_VY); // hop off the ground
    // floor horizontal speed toward the anchor
    _v.copy(this.anchor).sub(this.pos); _v.y = 0;
    if (_v.lengthSq() > 1e-4) {
      _v.normalize();
      _v2.copy(this.vel); _v2.y = 0;
      if (_v2.length() < ATTACH_MIN_SPEED) {
        const add = ATTACH_MIN_SPEED - _v2.length();
        this.vel.addScaledVector(_v, add);
      }
    }
    this.orangeBall.position.copy(this.anchor);
    this.orangeBall.visible = true;
    this.ropeMesh.visible = true;
    if (this.sfx) {
      this.sfx.play('shoot', { volume: 0.9 });      // 发射蛛丝
      this.sfx.startLoop('wind', 0);                // 荡绳风声（音量随速度）
    }
    if (this.anim) this._throwT = 0.4;              // 挥臂射丝动画窗口
  }

  _release() {
    this._detach();
    this.vel.multiplyScalar(RELEASE_MULT);
    this.vel.y += RELEASE_VY;
  }

  _detach() {
    this.swinging = false;
    this.orangeBall.visible = false;
    this.ropeMesh.visible = false;
    if (this.sfx) this.sfx.stopLoop('wind');
  }

  _tryZip() {
    const hit = this.aimHit;
    if (!hit) return;
    if (this.swinging) this._detach();
    const target = _v.copy(hit);
    const tb = this.aimBox && (this.aimBox.top || this.aimBox); // building's real top slice
    // roof snap: aimed near the parapet, OR the whole roof is a short hop away
    // (short buildings are direct; tall ones need the top edge or a stepping-stone roof)
    const roofSnap = tb && (tb.maxY - hit.y < 12 || tb.maxY - this.pos.y < 45);
    if (roofSnap) {
      // land on the building's top: clamp the hit point into the top slab's
      // footprint (with margin) so small crown/penthouse roofs still work
      const mX = Math.min(6, (tb.maxX - tb.minX) * 0.3);
      const mZ = Math.min(6, (tb.maxZ - tb.minZ) * 0.3);
      target.x = THREE.MathUtils.clamp(hit.x, tb.minX + mX, tb.maxX - mX);
      target.z = THREE.MathUtils.clamp(hit.z, tb.minZ + mZ, tb.maxZ - mZ);
      target.y = tb.maxY + ZIP_OVERSHOOT;
    } else {
      target.y += ZIP_OVERSHOOT;
    }
    const delta = target.sub(this.pos);
    // roof landings: arrive at (or past) the apex with limited horizontal speed,
    // so the arc settles onto the roof instead of sailing across it
    const horiz = Math.hypot(delta.x, delta.z);
    const t = roofSnap
      ? THREE.MathUtils.clamp(Math.max(Math.sqrt(2 * Math.max(delta.y, 1) / -G), horiz / 12), ZIP_TMIN, 3.0)
      : THREE.MathUtils.clamp(delta.length() / ZIP_SPEED, ZIP_TMIN, ZIP_TMAX);
    // v0 = Δ/t - ½ g t
    this.vel.copy(delta).multiplyScalar(1 / t);
    this.vel.y -= 0.5 * G * t;
    this.grounded = false;
    this._zipT = t + 0.3; // speed cap stays relaxed for the whole flight
    if (this.sfx) this.sfx.play('zip', { volume: 0.85 }); // 弹射起跳
  }

  // ---------- fixed-step physics ----------
  _step(h) {
    const k = this.keys;
    const fwd = _v.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = _v2.set(-fwd.z, 0, fwd.x);
    let wx = 0, wz = 0;
    if (k.KeyW) { wx += fwd.x; wz += fwd.z; }
    if (k.KeyS) { wx -= fwd.x; wz -= fwd.z; }
    if (k.KeyD) { wx += right.x; wz += right.z; }
    if (k.KeyA) { wx -= right.x; wz -= right.z; }
    const wishLen = Math.hypot(wx, wz);
    if (wishLen > 1e-3) { wx /= wishLen; wz /= wishLen; }

    this._zipT = Math.max(0, this._zipT - h);

    // gravity
    this.vel.y += G * h;

    if (this.swinging) {
        // W = reel in (climb), A/D = side arc force
        if (k.KeyW) this.ropeLen = Math.max(MIN_ROPE, this.ropeLen - REEL_SPEED * h);
        const rope = _v3.copy(this.pos).add({ x: 0, y: 1.0, z: 0 }).sub(this.anchor); // from anchor to body
        const dist = rope.length();
        const rhat = rope.multiplyScalar(1 / dist);
        if (dist > this.ropeLen) {
          // spring 90 / damper 9 along the rope (only when taut — a rope, not a rod)
          const stretch = dist - this.ropeLen;
          const vRad = this.vel.dot(rhat);
          const f = -ROPE_SPRING * stretch - ROPE_DAMPER * vRad;
          this.vel.addScaledVector(rhat, f * h);
        }
        // tangential boost, steered toward camera forward ("swing where you look")
        const vRad = this.vel.dot(rhat);
        _v4.copy(this.vel).addScaledVector(rhat, -vRad);            // tangential velocity
        const vt = _v4.length();
        _v5.copy(fwd).addScaledVector(rhat, -fwd.dot(rhat));        // camera fwd on the swing plane
        if (_v5.lengthSq() > 1e-4) _v5.normalize();
        if (vt > 0.5) {
          _v4.multiplyScalar(1 / vt);                               // motion dir
          _v4.lerp(_v5, SWING_STEER).normalize();
          this.vel.addScaledVector(_v4, TANGENT_BOOST * h);
        } else if (_v5.lengthSq() > 1e-4) {
          this.vel.addScaledVector(_v5, TANGENT_BOOST * h);         // from rest: push where you look
        }
      // side arc: camera-right force, de-projected from rope axis
      const side = (k.KeyD ? 1 : 0) - (k.KeyA ? 1 : 0);
      if (side) {
        _v4.copy(right).addScaledVector(rhat, -right.dot(rhat)).normalize();
        this.vel.addScaledVector(_v4, side * SIDE_FORCE * h);
      }
    } else if (this.grounded) {
      // direct velocity control: crisp start/stop
      const tx = wx * RUN_SPEED, tz = wz * RUN_SPEED;
      const dvx = tx - this.vel.x, dvz = tz - this.vel.z;
      const dv = Math.hypot(dvx, dvz), maxDv = RUN_ACCEL * h;
      if (dv > 1e-6) {
        const s = Math.min(1, maxDv / dv);
        this.vel.x += dvx * s; this.vel.z += dvz * s;
      }
      if (k.Space) {
        this.vel.y = JUMP_VY; this.grounded = false;
        if (this.sfx) this.sfx.play('jump', { volume: 0.55 }); // 起跳
      }
    } else {
      // air control
      if (wishLen > 1e-3) {
        this.vel.x += wx * AIR_CONTROL * h;
        this.vel.z += wz * AIR_CONTROL * h;
      }
    }

    // speed cap (relaxed during a zip so the ballistic solve isn't clipped)
    const cap = this._zipT > 0 ? 85 : MAX_SPEED;
    const sp = this.vel.length();
    if (sp > cap) this.vel.multiplyScalar(cap / sp);

    // integrate
    this.prevPos.copy(this.pos);
    this.pos.addScaledVector(this.vel, h);

    const wasGrounded = this.grounded;
    const vyBefore = this.vel.y;
    this._collide();
    this._landCd = Math.max(0, this._landCd - h);
    if (!wasGrounded && this.grounded && vyBefore < -7 && this._landCd <= 0) {
      // 落地：音量随下落冲击
      if (this.sfx) this.sfx.play('land', { volume: Math.min(1, -vyBefore / 28) });
      this._landCd = 0.3;
      // 落地动画：高处落地用越障收势，偶尔来个帅气定格（摆荡擦地不算落地）
      if (this.anim && vyBefore < -9 && !this.swinging) {
        this._animOneShot = Math.random() < 0.3
          ? { name: 'pose', t: 0, dur: 0.7 }
          : { name: 'jump', t: 0, dur: 0.55 };
      }
    }

    if (this.pos.y < -30) this.respawn();

    // soft city boundary: glide along it, never wander into the void
    if (this.bounds) {
      const { min, max } = this.bounds;
      if (this.pos.x < min) { this.pos.x = min; if (this.vel.x < 0) this.vel.x = 0; }
      else if (this.pos.x > max) { this.pos.x = max; if (this.vel.x > 0) this.vel.x = 0; }
      if (this.pos.z < min) { this.pos.z = min; if (this.vel.z < 0) this.vel.z = 0; }
      else if (this.pos.z > max) { this.pos.z = max; if (this.vel.z > 0) this.vel.z = 0; }
    }
  }

  _collide() {
    const r = this.radius, H = this.height;
    // ground / plates
    const gy = this.groundHeightAt(this.pos.x, this.pos.z);
    this.grounded = false;
    if (this.pos.y <= gy) {
      this.pos.y = gy;
      if (this.vel.y < 0) this.vel.y = 0;
      this.grounded = true;
    }
    // buildings (axis-aligned)
    for (const b of this.boxes) {
      if (this.pos.x < b.minX - r || this.pos.x > b.maxX + r) continue;
      if (this.pos.z < b.minZ - r || this.pos.z > b.maxZ + r) continue;
      if (this.pos.y > b.maxY || this.pos.y + H < b.minY) continue;

      if (b.isTop && b.mesh) {
        // top slab: mesh-accurate support ONLY — crowns are sloped/hollow and the
        // box is often larger than the real roof, so no solid-box behaviour here
        if (this.vel.y <= 0.01) {
          if (!this._downRay) this._downRay = new THREE.Raycaster();
          const top = Math.min(Math.max(this.prevPos.y, this.pos.y) + 0.6, b.maxY + 1);
          _v.set(this.pos.x, top, this.pos.z);
          this._downRay.set(_v, _v2.set(0, -1, 0));
          this._downRay.far = top - this.pos.y + 0.8;
          const hits = this._downRay.intersectObject(b.mesh, false);
          if (hits.length) {
            const hy = hits[0].point.y;
            if (this.pos.y <= hy + 0.05 && this.prevPos.y >= hy - 0.6) {
              this.pos.y = hy;
              if (this.vel.y < 0) this.vel.y = 0;
              this.grounded = true;
            }
          }
        }
        continue; // never push out horizontally from the crown box
      }

      // roof landing (lower slabs = setback ledges): was above this slab's top
      // last step and moving down — but not if another slab covers this spot
      if (this.prevPos.y >= b.maxY - 0.01 && this.vel.y <= 0.01 &&
          this.pos.x > b.minX - r * 0.5 && this.pos.x < b.maxX + r * 0.5 &&
          this.pos.z > b.minZ - r * 0.5 && this.pos.z < b.maxZ + r * 0.5) {
        let covered = false;
        for (const b2 of this.boxes) {
          if (b2 === b) continue;
          if (b.maxY + 0.05 < b2.minY || b.maxY + 0.05 > b2.maxY) continue;
          if (this.pos.x > b2.minX - 0.1 && this.pos.x < b2.maxX + 0.1 &&
              this.pos.z > b2.minZ - 0.1 && this.pos.z < b2.maxZ + 0.1) { covered = true; break; }
        }
        if (!covered && b.mesh) {
          // ledge tops can also overhang the real geometry — require mesh underfoot
          if (!this._downRay) this._downRay = new THREE.Raycaster();
          _v.set(this.pos.x, b.maxY + 0.5, this.pos.z);
          this._downRay.set(_v, _v2.set(0, -1, 0));
          this._downRay.far = 3;
          const hits = this._downRay.intersectObject(b.mesh, false);
          if (!hits.length || b.maxY - hits[0].point.y > 1.0) covered = true; // air below
        }
        if (!covered) {
          this.pos.y = b.maxY;
          if (this.vel.y < 0) this.vel.y = 0;
          this.grounded = true;
          continue;
        }
      }
      // horizontal push-out along the smallest penetration axis
      const pxa = this.pos.x - (b.minX - r), pxb = (b.maxX + r) - this.pos.x;
      const pza = this.pos.z - (b.minZ - r), pzb = (b.maxZ + r) - this.pos.z;
      const m = Math.min(pxa, pxb, pza, pzb);
      if (m === pxa) { this.pos.x = b.minX - r; if (this.vel.x > 0) this.vel.x = 0; }
      else if (m === pxb) { this.pos.x = b.maxX + r; if (this.vel.x < 0) this.vel.x = 0; }
      else if (m === pza) { this.pos.z = b.minZ - r; if (this.vel.z > 0) this.vel.z = 0; }
      else { this.pos.z = b.maxZ + r; if (this.vel.z < 0) this.vel.z = 0; }
    }
  }

  // ---------- per-frame update ----------
  update(dt) {
    this._t += dt;
    this._acc = Math.min(this._acc + dt, 0.1);
    while (this._acc >= FIXED_DT) { this._step(FIXED_DT); this._acc -= FIXED_DT; }
    const alpha = this._acc / FIXED_DT;
    const rp = this._rp.copy(this.prevPos).lerp(this.pos, alpha); // render pos (interpolated)

    // aim every frame
    const aimRes = this.swinging ? null : this._aim();
    this.aimHit = aimRes ? aimRes.hit : null;
    this.aimBox = aimRes ? aimRes.box : null;
    if (this.aimHit) {
      this.greenBall.visible = true;
      this.greenBall.position.copy(this.aimHit);
      const d = this.aimHit.distanceTo(this.camera.position);
      const breathe = 1 + 0.16 * Math.sin(this._t * 4.5);
      this.greenBall.scale.setScalar(Math.max(0.55, d * 0.018) * breathe);
      const m = this.greenBall.material;
      m.opacity = 0.72 + 0.22 * Math.sin(this._t * 4.5);
    } else this.greenBall.visible = false;

    // rope visual
    if (this.swinging) {
      const hand = this._handPos(_v2);
      const len = hand.distanceTo(this.anchor);
      this.ropeMesh.position.copy(hand);
      this.ropeMesh.scale.set(1, len, 1);
      this.ropeMesh.quaternion.setFromUnitVectors(
        _v3.set(0, 1, 0),
        _v.copy(this.anchor).sub(hand).normalize()
      );
      this.orangeBall.position.copy(this.anchor);
      // 荡绳风声随速度起伏
      if (this.sfx) this.sfx.setLoopVolume('wind', THREE.MathUtils.clamp((this.vel.length() - 6) / 26, 0, 1) * 0.7);
    }

    this._updateVisual(rp, dt);
    this._updateCamera(rp, dt);

    // global speed-wind: no trigger logic, purely follows physics velocity.
    // silent below 8 m/s, howling and pitched-up toward 40 m/s
    if (this.sfx && this.sfx.ready) {
      this.sfx.startLoop('speedwind', 0); // idempotent
      const t = THREE.MathUtils.clamp((this.vel.length() - 8) / (40 - 8), 0, 1);
      this.sfx.setLoopVolume('speedwind', t * 0.85);
      this.sfx.setLoopRate('speedwind', 0.85 + 0.45 * t);
    }
  }

  // pick + drive the skeletal clip; the segmented hero is ALWAYS clip-driven
  _updateAnim(dt) {
    if (!this.anim) return false;
    this._throwT = Math.max(0, this._throwT - dt);
    this._airTime = this.grounded ? 0 : this._airTime + dt;
    let name = null;
    if (this._animOneShot) {
      const os = this._animOneShot;
      os.t += dt;
      if (os.t >= os.dur) this._animOneShot = null;
      else name = os.name;
    }
    if (!name) {
      if (this.swinging) name = this._throwT > 0 ? 'throw' : 'fly';        // 射丝挥臂 → 飞荡循环
      else if (this._zipT > 0.25 && !this.grounded) name = 'climb';        // zip 弹射：爬绳
      else if (this._airTime > 0.15) name = 'air';                          // 滞空舒展
      else name = 'idle';                                                   // 地面待机
    }
    if (name !== this._curAnim) {
      if (this._curAnim) this._actions[this._curAnim].fadeOut(0.15);
      if (name) {
        const a = this._actions[name];
        const dur = a.getClip().duration;
        a.reset();
        if (name === 'throw') a.timeScale = dur / 0.4;                     // 1.2s 剪辑压到 0.4s 挥臂
        else if (name === 'jump') { a.time = dur * 0.5; a.timeScale = (dur * 0.5) / 0.55; } // 落地收势段
        else a.timeScale = name === 'climb' ? 1.5 : 1;
        a.fadeIn(0.12).play();
      }
      this._curAnim = name;
    }
    this._mixer.update(dt);
    if (!name) {
      // keep the rig visible through the fade-out, then hand back to static poses
      this._animFade = Math.max(0, this._animFade - dt);
      this.anim.group.visible = this._animFade > 0;
      this._animLiftTarget = 0;
      return this.anim.group.visible;
    }
    this._animFade = 0.15;
    this.anim.group.visible = true;
    // ground-plant: measure the lowest foot bone live (the lift is applied AFTER
    // this in _updateVisual, so the measurement excludes it) and target -err so
    // the feet land exactly on the ground, whatever the pose's foot height
    if (this.grounded) {
      this.anim.group.updateWorldMatrix(true, true);
      let lowest = Infinity;
      for (const fb of this._footBones) lowest = Math.min(lowest, fb.getWorldPosition(this._footTmp).y);
      if (lowest !== Infinity) this._animLiftTarget = -(lowest - this.pos.y);
    } else this._animLiftTarget = 0;
    return true;
  }

  _updateVisual(rp, dt) {
    this.visual.position.copy(rp);
    const animShowing = this._updateAnim(dt);
    if (!animShowing) this._animLiftTarget = 0;
    this._animLift += ((this._animLiftTarget || 0) - this._animLift) * Math.min(1, dt * 14);
    this.visual.position.y += this._animLift;
    if (this.poseGround) {
      const air = this.swinging || !this.grounded;
      this.poseGround.visible = !animShowing && !air;
      this.poseAir.visible = !animShowing && air;
    }
    const vh = Math.hypot(this.vel.x, this.vel.z);
    const speed = this.vel.length();
    if (vh > 2) {
      const targetYaw = Math.atan2(this.vel.x, this.vel.z);
      let d = targetYaw - this.visYaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      this.visYaw += d * Math.min(1, dt * 8);
    }
    // lean: swinging up to 38°, airborne 12°, grounded 0
    const target = this.swinging ? THREE.MathUtils.degToRad(38) * Math.min(1, speed / 25)
      : (!this.grounded ? THREE.MathUtils.degToRad(12) : 0);
    this.visTilt += (target - this.visTilt) * Math.min(1, dt * 6);
    this.visual.rotation.set(this.visTilt, this.visYaw, 0);
  }

  _updateCamera(rp, dt) {
    // smoothed anchor absorbs physics stepping / sharp arcs — steadier view
    if (!this._camAnchor) this._camAnchor = new THREE.Vector3().copy(rp);
    this._camAnchor.lerp(rp, 1 - Math.exp(-16 * dt));
    const a = this._camAnchor;
    const pivot = _v.set(a.x, a.y + CAM_PIVOT_H, a.z);
    // pitch>0 sinks the camera and tilts the view UP (mouse-up looks up)
    const dir = _v2.set(
      Math.sin(this.yaw) * Math.cos(this.pitch),
      -Math.sin(this.pitch),
      Math.cos(this.yaw) * Math.cos(this.pitch)
    );
    // occlusion: pull in instantly, recover slowly (asymmetric)
    let want = this.camDist;
    let occ = want;
    for (const b of this.boxes) {
      const t = b.raycast(pivot, dir, want + 0.4);
      if (t < occ + 0.4) occ = Math.min(occ, Math.max(CAM_MIN * 0.5, t - 0.35));
    }
    if (occ < this.camDistCur) this.camDistCur = occ;                     // snap in
    else this.camDistCur += (Math.min(want, occ) - this.camDistCur) * Math.min(1, dt * CAM_RECOVER); // ease out

    this.camera.position.copy(pivot).addScaledVector(dir, this.camDistCur);
    if (this.camera.position.y < a.y + 0.25) this.camera.position.y = a.y + 0.25; // never below feet
    this.camera.lookAt(a.x, a.y + CAM_LOOK_H, a.z);

    // speed-driven FOV (gentle)
    const speed = this.vel.length();
    const f = THREE.MathUtils.clamp((speed - FOV_V0) / (FOV_V1 - FOV_V0), 0, 1);
    const fov = FOV_BASE + (FOV_MAX - FOV_BASE) * f;
    if (Math.abs(fov - this.camera.fov) > 0.05) {
      this.camera.fov += (fov - this.camera.fov) * Math.min(1, dt * 2.2);
      this.camera.updateProjectionMatrix();
    }
  }

  speed() { return this.vel.length(); }
}

export { AABB };
