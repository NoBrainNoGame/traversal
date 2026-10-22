import * as THREE from "three"
import { PIECES, type PieceType, type Seat } from "../shared/rules"
import { TEAM_COLORS } from "./scenery"

// Low-poly characters built from primitives, each one shaped after its role:
// the explorer is a slim scout riding a goat with a banner, the vanguard a spear-and-shield soldier,
// the sentinel a big muscular brute. Stats float at their feet as badges (movement left in green, strength right in red).

type V3 = [number, number, number]
type Materials = ReturnType<typeof makeMaterials>

const UP = new THREE.Vector3(0, 1, 0)

function makeMaterials(seat: Seat) {
  const mat = (color: number, extra: THREE.MeshStandardMaterialParameters = {}) =>
    new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.7, transparent: true, ...extra })
  const team = new THREE.Color(TEAM_COLORS[seat])
  return {
    team: mat(team.getHex()),
    teamDark: mat(team.clone().multiplyScalar(0.55).getHex()),
    skin: mat(0xe0b088),
    leather: mat(0x5e3d26),
    wood: mat(0x8a6038),
    metal: mat(0xc2c6cf, { metalness: 0.6, roughness: 0.35 }),
    dark: mat(0x2a2522),
    fur: mat(0xece4d4),
    horn: mat(0x9a9188),
    flag: mat(team.getHex(), { side: THREE.DoubleSide }),
  }
}

function add(parent: THREE.Object3D, geo: THREE.BufferGeometry, material: THREE.Material, at: V3, rot: V3 = [0, 0, 0], scale: V3 = [1, 1, 1]) {
  const mesh = new THREE.Mesh(geo, material)
  mesh.position.set(...at)
  mesh.rotation.set(...rot)
  mesh.scale.set(...scale)
  mesh.castShadow = true
  parent.add(mesh)
  return mesh
}

/** A tapered cylinder from a to b (arms, legs, poles) */
function limb(parent: THREE.Object3D, a: V3, b: V3, r0: number, r1: number, material: THREE.Material) {
  const va = new THREE.Vector3(...a),
    vb = new THREE.Vector3(...b)
  const dir = vb.clone().sub(va)
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r1, r0, dir.length(), 7), material)
  mesh.position.copy(va).add(vb).multiplyScalar(0.5)
  mesh.quaternion.setFromUnitVectors(UP, dir.normalize())
  mesh.castShadow = true
  parent.add(mesh)
  return mesh
}

const sphere = (r: number) => new THREE.SphereGeometry(r, 10, 8)

/** A joint: parts added to it are placed relative to `at` and turn around it */
function joint(parent: THREE.Object3D, at: V3) {
  const group = new THREE.Group()
  group.position.set(...at)
  group.userData.home = group.position.clone()
  parent.add(group)
  return group
}

/** The moving parts the animations drive (see motion.ts); each piece type has its own */
export interface Parts {
  /** Goat legs, turning at the hip */
  frontLegs?: THREE.Group[]
  backLegs?: THREE.Group[]
  /** Goat neck and head, turning at the base of the neck (lowered to charge) */
  head?: THREE.Group
  /** Soldier legs, turning at the hip */
  legs?: THREE.Group[]
  /** The spear, turning in the hand */
  spear?: THREE.Group
  /** The brute standing, and curled up into a spiked ball */
  body?: THREE.Group
  ball?: THREE.Group
  /** Spins inside `ball` as it rolls */
  ballSpin?: THREE.Group
}

/** Radius of the sentinel's rolling ball */
export const BALL_RADIUS = 0.21

type Built = { model: THREE.Group; parts: Parts }

function buildExplorer(m: Materials): Built {
  const model = new THREE.Group()
  const frontLegs: THREE.Group[] = [],
    backLegs: THREE.Group[] = []
  // The goat
  add(model, new THREE.CapsuleGeometry(0.095, 0.2, 4, 8).rotateX(Math.PI / 2), m.fur, [0, 0.27, 0])
  for (const sx of [-0.06, 0.06])
    for (const sz of [-0.11, 0.11]) {
      const leg = joint(model, [sx, 0.26, sz])
      limb(leg, [0, 0, 0], [0, -0.23, 0.01], 0.026, 0.02, m.fur)
      add(leg, sphere(0.024), m.dark, [0, -0.24, 0.01], [0, 0, 0], [1, 0.6, 1.2])
      ;(sz > 0 ? frontLegs : backLegs).push(leg)
    }
  const head = joint(model, [0, 0.3, 0.12])
  limb(head, [0, 0, 0], [0, 0.13, 0.08], 0.05, 0.038, m.fur)
  add(head, new THREE.CapsuleGeometry(0.042, 0.07, 4, 8).rotateX(Math.PI / 2), m.fur, [0, 0.15, 0.13], [0.55, 0, 0])
  add(head, new THREE.ConeGeometry(0.02, 0.06, 5), m.fur, [0, 0.07, 0.17], [Math.PI, 0, 0])
  for (const s of [-1, 1]) {
    add(head, new THREE.TorusGeometry(0.045, 0.012, 5, 10, Math.PI * 1.15), m.horn, [s * 0.028, 0.2, 0.09], [0, Math.PI / 2, 0.2])
    add(head, new THREE.BoxGeometry(0.05, 0.015, 0.025), m.fur, [s * 0.05, 0.17, 0.1], [0, 0, s * -0.4])
  }
  add(model, new THREE.ConeGeometry(0.02, 0.06, 5), m.fur, [0, 0.33, -0.17], [-0.8, 0, 0])
  add(model, new THREE.BoxGeometry(0.17, 0.03, 0.14), m.team, [0, 0.36, -0.01])
  // The rider: slim, straddling the goat, banner in hand
  for (const s of [-1, 1]) {
    limb(model, [s * 0.04, 0.42, 0], [s * 0.11, 0.34, 0.04], 0.022, 0.02, m.leather)
    limb(model, [s * 0.11, 0.34, 0.04], [s * 0.1, 0.22, 0], 0.02, 0.017, m.leather)
  }
  limb(model, [0, 0.4, 0], [0, 0.6, 0.01], 0.06, 0.05, m.team)
  add(model, sphere(0.056), m.skin, [0, 0.66, 0.02])
  add(model, new THREE.ConeGeometry(0.064, 0.12, 8), m.teamDark, [0, 0.73, 0], [-0.25, 0, 0])
  limb(model, [-0.06, 0.57, 0], [-0.11, 0.5, 0.07], 0.018, 0.015, m.team)
  limb(model, [0.06, 0.57, 0], [0.05, 0.47, 0.12], 0.018, 0.015, m.team)
  limb(model, [-0.11, 0.28, 0.07], [-0.11, 1.05, 0.05], 0.011, 0.011, m.wood)
  add(model, sphere(0.02), m.metal, [-0.11, 1.06, 0.05])
  const flag = new THREE.Group()
  flag.position.set(-0.11, 0.96, 0.05)
  const cloth = new THREE.PlaneGeometry(0.26, 0.16, 8, 1).translate(0.13, 0, 0)
  const pos = cloth.attributes.position
  for (let i = 0; i < pos.count; i++) pos.setZ(i, Math.sin(pos.getX(i) * 22) * 0.02 * (pos.getX(i) / 0.26))
  cloth.computeVertexNormals()
  add(flag, cloth, m.flag, [0, 0, 0])
  model.add(flag)
  model.userData.animate = (t: number) => (flag.rotation.y = Math.PI / 2 + Math.sin(t * 3) * 0.25)
  return { model, parts: { frontLegs, backLegs, head } }
}

function buildVanguard(m: Materials): Built {
  const model = new THREE.Group()
  const legs = [-1, 1].map((s) => {
    const leg = joint(model, [s * 0.05, 0.23, 0])
    limb(leg, [0, 0, 0], [s * 0.01, -0.19, 0.01], 0.034, 0.03, m.leather)
    add(leg, sphere(0.04), m.dark, [s * 0.01, -0.2, 0.02], [0, 0, 0], [1, 0.6, 1.4])
    return leg
  })
  add(model, new THREE.CylinderGeometry(0.085, 0.11, 0.1, 8), m.team, [0, 0.25, 0])
  add(model, new THREE.CylinderGeometry(0.1, 0.088, 0.14, 8), m.metal, [0, 0.37, 0])
  add(model, new THREE.CylinderGeometry(0.09, 0.09, 0.025, 8), m.leather, [0, 0.305, 0])
  for (const s of [-1, 1]) add(model, sphere(0.045), m.metal, [s * 0.1, 0.43, 0])
  add(model, sphere(0.068), m.skin, [0, 0.52, 0])
  add(model, new THREE.SphereGeometry(0.076, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), m.metal, [0, 0.53, 0])
  add(model, new THREE.BoxGeometry(0.022, 0.05, 0.14), m.team, [0, 0.61, -0.01])
  add(model, new THREE.BoxGeometry(0.014, 0.05, 0.014), m.metal, [0, 0.51, 0.07])
  // Spear arm and shield arm
  limb(model, [-0.1, 0.42, 0], [-0.13, 0.33, 0.05], 0.025, 0.022, m.team)
  limb(model, [-0.13, 0.33, 0.05], [-0.12, 0.31, 0.11], 0.022, 0.02, m.skin)
  limb(model, [0.1, 0.42, 0], [0.13, 0.34, 0.07], 0.025, 0.022, m.team)
  // The spear turns around the point where the hand holds it
  const grip = joint(model, [-0.12, 0.31, 0])
  const spear = limb(grip, [0, -0.26, -0.18], [0, 0.47, 0.33], 0.011, 0.011, m.wood)
  const tip = add(grip, new THREE.ConeGeometry(0.025, 0.09, 5), m.metal, [0, 0, 0])
  tip.quaternion.copy(spear.quaternion)
  tip.position.set(0, 0.47, 0.33).add(new THREE.Vector3(0, 0.045, 0).applyQuaternion(spear.quaternion))
  add(model, new THREE.CylinderGeometry(0.13, 0.13, 0.025, 14).rotateX(Math.PI / 2), m.team, [0.16, 0.34, 0.11], [0, 0.45, 0])
  add(model, new THREE.TorusGeometry(0.13, 0.012, 5, 20), m.metal, [0.16, 0.34, 0.11], [0, 0.45, 0])
  add(model, sphere(0.03), m.metal, [0.165, 0.34, 0.125])
  return { model, parts: { legs, spear: grip } }
}

function buildSentinel(m: Materials): Built {
  const model = new THREE.Group()
  const body = joint(model, [0, 0, 0])
  for (const s of [-1, 1]) {
    limb(body, [s * 0.09, 0.22, 0], [s * 0.11, 0.04, 0.02], 0.065, 0.055, m.leather)
    add(body, sphere(0.06), m.dark, [s * 0.11, 0.03, 0.04], [0, 0, 0], [1.1, 0.6, 1.4])
  }
  add(body, new THREE.CylinderGeometry(0.17, 0.16, 0.09, 9), m.team, [0, 0.23, 0])
  add(body, new THREE.BoxGeometry(0.06, 0.045, 0.02), m.metal, [0, 0.24, 0.16])
  // Barrel chest, huge shoulders, arms hanging down to big fists
  add(body, sphere(0.19), m.skin, [0, 0.4, 0], [0, 0, 0], [1.25, 1, 0.9])
  for (const s of [-1, 1]) {
    add(body, sphere(0.08), m.skin, [s * 0.075, 0.46, 0.12], [0, 0, 0], [1, 0.7, 0.6])
    add(body, new THREE.SphereGeometry(0.1, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), m.team, [s * 0.21, 0.51, 0], [0, 0, s * -0.35])
    add(body, new THREE.ConeGeometry(0.02, 0.06, 5), m.metal, [s * 0.25, 0.6, 0], [0, 0, s * -0.5])
    limb(body, [s * 0.22, 0.5, 0], [s * 0.28, 0.33, 0.04], 0.075, 0.065, m.skin)
    limb(body, [s * 0.28, 0.33, 0.04], [s * 0.27, 0.16, 0.1], 0.065, 0.08, m.skin)
    add(body, new THREE.CylinderGeometry(0.075, 0.075, 0.06, 8), m.leather, [s * 0.275, 0.22, 0.08], [0.35, 0, 0])
    add(body, sphere(0.075), m.skin, [s * 0.27, 0.13, 0.11])
  }
  add(body, sphere(0.07), m.skin, [0, 0.59, 0.07])
  add(body, new THREE.TorusGeometry(0.066, 0.014, 5, 14), m.team, [0, 0.62, 0.07], [Math.PI / 2, 0, 0])
  for (const s of [-1, 1]) add(body, sphere(0.011), m.dark, [s * 0.025, 0.6, 0.135])
  add(body, new THREE.BoxGeometry(0.07, 0.012, 0.02), m.dark, [0, 0.615, 0.128])
  // Curled up: a spiked ball in the team colour, for rolling and crushing
  const ball = joint(model, [0, BALL_RADIUS, 0])
  ball.visible = false
  const ballSpin = joint(ball, [0, 0, 0])
  add(ballSpin, new THREE.IcosahedronGeometry(BALL_RADIUS, 1), m.team, [0, 0, 0])
  add(ballSpin, new THREE.TorusGeometry(BALL_RADIUS * 0.98, 0.022, 5, 18), m.skin, [0, 0, 0], [0, Math.PI / 2, 0])
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2
    const dir = new THREE.Vector3(0.35 * (i % 2 ? 1 : -1), Math.cos(a), Math.sin(a)).normalize()
    const quill = add(ballSpin, new THREE.ConeGeometry(0.05, 0.14, 5), m.teamDark, dir.clone().multiplyScalar(BALL_RADIUS + 0.04).toArray() as V3)
    quill.quaternion.setFromUnitVectors(UP, dir)
  }
  return { model, parts: { body, ball, ballSpin } }
}

const BUILDERS: Record<PieceType, (m: Materials) => Built> = {
  explorer: buildExplorer,
  vanguard: buildVanguard,
  sentinel: buildSentinel,
}

/** A stat badge: number and icon on a coloured tag (movement: green arrow, strength: red sword) */
function badgeTexture(value: number, kind: "move" | "strength") {
  const canvas = document.createElement("canvas")
  canvas.width = 160
  canvas.height = 112
  const ctx = canvas.getContext("2d")!
  ctx.fillStyle = kind === "move" ? "#48b85a" : "#e0443a"
  ctx.strokeStyle = "#2a1a12"
  ctx.lineWidth = 8
  ctx.beginPath()
  ctx.roundRect(8, 12, 144, 88, 26)
  ctx.fill()
  ctx.stroke()
  ctx.font = "bold 76px sans-serif"
  ctx.textAlign = "center"
  ctx.textBaseline = "middle"
  ctx.lineWidth = 10
  ctx.strokeText(String(value), 58, 60)
  ctx.fillStyle = "#fff"
  ctx.fillText(String(value), 58, 60)
  ctx.lineWidth = 5
  ctx.lineJoin = "round"
  ctx.fillStyle = "#fff"
  ctx.translate(120, 56)
  if (kind === "move") {
    // Upward arrow
    ctx.beginPath()
    ctx.moveTo(-6, 28)
    ctx.lineTo(-6, -4)
    ctx.lineTo(-18, -4)
    ctx.lineTo(0, -28)
    ctx.lineTo(18, -4)
    ctx.lineTo(6, -4)
    ctx.lineTo(6, 28)
    ctx.closePath()
    ctx.stroke()
    ctx.fill()
  } else {
    // Sword, tilted, blade up, scaled down to sit inside the tag
    ctx.rotate(Math.PI / 4)
    ctx.scale(0.72, 0.72)
    ctx.lineWidth = 6
    const shapes = [
      () => {
        ctx.moveTo(-6, 8)
        ctx.lineTo(-6, -26)
        ctx.lineTo(0, -36)
        ctx.lineTo(6, -26)
        ctx.lineTo(6, 8)
      },
      () => ctx.rect(-16, 8, 32, 7),
      () => ctx.rect(-4, 15, 8, 14),
      () => ctx.arc(0, 32, 6, 0, Math.PI * 2),
    ]
    for (const shape of shapes) {
      ctx.beginPath()
      shape()
      ctx.closePath()
      ctx.stroke()
      ctx.fill()
    }
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

function badge(value: number, kind: "move" | "strength") {
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: badgeTexture(value, kind), depthTest: false, transparent: true }))
  sprite.scale.set(0.25, 0.175, 1)
  sprite.renderOrder = 20
  return sprite
}

export interface PieceView {
  holder: THREE.Group
  /** Turns to face where it walks; the holder itself never rotates, so the badges stay put */
  model: THREE.Group
  parts: Parts
  type: PieceType
  badges: { move: THREE.Sprite; strength: THREE.Sprite }
}

export function makePiece(type: PieceType, seat: Seat, id: number): PieceView {
  const materials = makeMaterials(seat)
  const holder = new THREE.Group()
  holder.userData.pieceId = id
  const { model, parts } = BUILDERS[type](materials)
  // Turn first, then lean: the animations pitch the model forward and back along where it faces
  model.rotation.order = "YXZ"
  model.rotation.y = seat === 0 ? 0 : Math.PI
  // Team-coloured base so ownership reads at a glance
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(0.29, 0.31, 0.025, 28),
    new THREE.MeshStandardMaterial({ color: TEAM_COLORS[seat], emissive: TEAM_COLORS[seat], emissiveIntensity: 0.2, transparent: true, opacity: 0.7 }),
  )
  base.position.y = 0.013
  base.receiveShadow = true
  const def = PIECES[type]
  const badges = { move: badge(def.move, "move"), strength: badge(def.strength, "strength") }
  holder.add(base, model, badges.move, badges.strength)
  return { holder, model, parts, type, badges }
}

export function setPieceOpacity(view: PieceView, opacity: number) {
  view.holder.traverse((o) => {
    const material = (o as THREE.Mesh).material as THREE.Material | undefined
    if (!material) return
    material.userData.baseOpacity ??= material.opacity
    material.opacity = material.userData.baseOpacity * opacity
  })
}
