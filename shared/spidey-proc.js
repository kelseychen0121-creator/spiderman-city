// Procedural Spider-Man: rigid primitive segments attached directly to the
// native Mixamo skeleton. No skinning -> mesh deformation artifacts are
// impossible by construction. Styled after Miles: black suit, red accents,
// big white eyes, red chest spider.
import * as THREE from 'three';

export function buildProcSpidey(rigRoot) {
  const bones = {};
  rigRoot.traverse(o => { if (o.name) bones[o.name] = o; });
  rigRoot.updateMatrixWorld(true);
  const B = n => bones['mixamorig' + n];

  const suit = new THREE.MeshStandardMaterial({ color: 0x141418, roughness: 0.5, metalness: 0.05 });
  const suitRed = new THREE.MeshStandardMaterial({ color: 0xb01020, roughness: 0.45, metalness: 0.05 });
  const white = new THREE.MeshStandardMaterial({ color: 0xf2f5f5, roughness: 0.35 });
  const darkSole = new THREE.MeshStandardMaterial({ color: 0x2a2a2e, roughness: 0.8 });

  const meshes = [];
  const add = (parent, geo, mat) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    parent.add(m);
    meshes.push(m);
    return m;
  };
  const Y = new THREE.Vector3(0, 1, 0);

  // capsule from a bone's origin to its child bone (rest local space)
  const seg = (fromName, toName, r0, r1 = r0, mat = suit, endPad = 0) => {
    const A = B(fromName), C = B(toName);
    const v = C.position.clone();
    const len = Math.max(1, v.length() + endPad);
    const dir = v.clone().normalize();
    // tapered capsule = cylinder + end spheres
    const g = new THREE.CylinderGeometry(r1, r0, len, 10);
    const m = add(A, g, mat);
    m.quaternion.setFromUnitVectors(Y, dir);
    m.position.copy(dir).multiplyScalar(len / 2);
    add(A, new THREE.SphereGeometry(r0, 10, 8), mat); // joint ball at the pivot
    const end = add(A, new THREE.SphereGeometry(r1, 10, 8), mat);
    end.position.copy(dir).multiplyScalar(len);
    return m;
  };
  const ballAt = (name, r, mat = suit, sx = 1, sy = 1, sz = 1, localOffset = null) => {
    const m = add(B(name), new THREE.SphereGeometry(r, 14, 10), mat);
    m.scale.set(sx, sy, sz);
    if (localOffset) m.position.copy(localOffset);
    return m;
  };
  // convert a world-space offset (rest pose) into a bone's local space
  const worldOffset = (name, wx, wy, wz) => {
    const b = B(name);
    const p = b.getWorldPosition(new THREE.Vector3());
    return b.worldToLocal(p.clone().add(new THREE.Vector3(wx, wy, wz)));
  };

  // ---- torso (units: centimetres, rig is FBX-scale) ----
  seg('Hips', 'Spine', 11.5, 12);
  seg('Spine', 'Spine1', 12, 12.5);
  seg('Spine1', 'Spine2', 12.5, 12);
  seg('Spine2', 'Neck', 11, 7.5);
  ballAt('Hips', 12.5, suit, 1.15, 0.9, 0.85);
  ballAt('Spine1', 13, suit, 1.15, 1.05, 0.8);   // chest
  seg('Neck', 'Head', 5.5, 5.5);

  // ---- head + eyes ----
  const headLen = B('HeadTop_End').position.length();
  const headC = worldOffset('Head', 0, headLen * 0.42, 1.5);
  const head = add(B('Head'), new THREE.SphereGeometry(headLen * 0.52, 18, 14), suit);
  head.position.copy(headC);
  head.scale.set(0.92, 1.05, 0.98);
  for (const s of [-1, 1]) {
    const eye = add(B('Head'), new THREE.SphereGeometry(headLen * 0.23, 12, 10), white);
    eye.position.copy(worldOffset('Head', s * headLen * 0.24, headLen * 0.46, headLen * 0.42));
    eye.scale.set(0.75, 0.95, 0.35);
    eye.rotation.z = -s * 0.5;
    eye.rotation.y = s * 0.35;
  }

  // ---- chest spider (flat red body + 8 thin legs) ----
  {
    const chest = B('Spine1');
    const anchor = worldOffset('Spine1', 0, 6, 13.2);
    const body = add(chest, new THREE.SphereGeometry(2.6, 8, 6), suitRed);
    body.position.copy(anchor);
    body.scale.set(0.8, 1.5, 0.4);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      const leg = add(chest, new THREE.BoxGeometry(0.9, 7.5, 0.7), suitRed);
      leg.position.copy(anchor).add(new THREE.Vector3(Math.cos(a) * 4.4, Math.sin(a) * 4.4 + 1.2, 0.4));
      leg.rotation.z = a + Math.PI / 2;
    }
  }

  // ---- arms ----
  for (const s of ['Left', 'Right']) {
    seg(`${s}Shoulder`, `${s}Arm`, 5.5, 6);
    seg(`${s}Arm`, `${s}ForeArm`, 5.6, 4.6);
    seg(`${s}ForeArm`, `${s}Hand`, 4.4, 3.6);
    ballAt(`${s}Hand`, 4.6, suitRed, 1, 1.25, 1);   // red gloves (fingertips)
  }

  // ---- legs + feet ----
  for (const s of ['Left', 'Right']) {
    seg(`${s}UpLeg`, `${s}Leg`, 7.6, 5.8);
    seg(`${s}Leg`, `${s}Foot`, 5.6, 4.2);
    const foot = seg(`${s}Foot`, `${s}ToeBase`, 4.4, 3.8, suitRed, 2);
    foot.scale.x = 1.15;
    const toe = B(`${s}ToeBase`);
    const tip = add(toe, new THREE.SphereGeometry(3.6, 10, 8), suitRed);
    tip.position.copy(B(`${s}ToeBase`).children.find(c => c.name.includes('Toe_End'))?.position || new THREE.Vector3());
    tip.scale.set(1.1, 0.7, 1);
    // dark sole
    const sole = add(B(`${s}Foot`), new THREE.BoxGeometry(9, 2.2, 16), darkSole);
    const toeLocal = B(`${s}ToeBase`).position;
    sole.quaternion.setFromUnitVectors(Y, toeLocal.clone().normalize());
    sole.position.copy(toeLocal).multiplyScalar(0.55).add(new THREE.Vector3(0, 0, 0));
  }
  return { meshes };
}
