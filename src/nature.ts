import * as THREE from "three"
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js"
import { N } from "../shared/rules"
import { barrierZ, outerHeight } from "./scenery"
import { enchant, random, softDot } from "./shading"

// Plants and animals around the board (never on it): trees, bushes, rocks, flowers and grass swaying in the wind;
// birds circling, butterflies, rabbits hopping about, fish leaping out of the lakes, and floating motes of light.

const HALF = N / 2
/** How far from the board things grow */
const REACH = 40

const { smoothstep, lerp } = THREE.MathUtils

/** Distance from the board's edge (0 on it) */
const offBoard = (x: number, z: number) => Math.hypot(Math.max(Math.abs(x) - HALF, 0), Math.max(Math.abs(z) - HALF, 0))

const TAU = Math.PI * 2

export class Nature {
  readonly group = new THREE.Group()
  private rand: () => number
  private ground: (x: number, z: number) => number
  private animals: { update: (time: number, dt: number) => void }[] = []

  constructor(
    private heights: number[],
    private waterLevel: number,
  ) {
    this.rand = random(heights.reduce((h, v, i) => (h * 31 + v * (i + 7)) | 0, 17))
    this.ground = (x, z) => outerHeight(heights, x, z)
    this.plantTrees()
    this.scatter(bushGeometry(), 0x3f6b35, 110, 0.6, 22, [0.6, 1.2], { wind: 0.12, sink: 0.05 })
    this.scatter(rockGeometry(), 0x85807a, 70, 0.5, REACH, [0.4, 1.3], { sink: 0.12, spin: true })
    this.scatter(grassGeometry(), 0x5f9a45, 1400, 0.3, 26, [0.7, 1.3], { wind: 0.6 })
    this.plantFlowers()
    this.addBirds()
    this.addButterflies()
    this.addRabbits()
    this.addFish()
    this.addMotes()
  }

  update(time: number, dt: number) {
    for (const animal of this.animals) animal.update(time, dt)
  }

  // ---------------------------------------------------------------- where things go

  /** A free spot of dry land outside the board, between two distances from it, clear of the goal barriers */
  private spot(min: number, max: number, clearance = 0.8): THREE.Vector3 | null {
    for (let tries = 0; tries < 30; tries++) {
      const angle = this.rand() * TAU
      const r = HALF * 1.2 + lerp(min, max, Math.sqrt(this.rand()))
      const x = Math.cos(angle) * r,
        z = Math.sin(angle) * r
      const d = offBoard(x, z)
      if (d < min || d > max) continue
      if (Math.abs(z - barrierZ(0, x)) < clearance || Math.abs(z - barrierZ(1, x)) < clearance) continue
      const y = this.ground(x, z)
      if (y < this.waterLevel + 0.08) continue
      return new THREE.Vector3(x, y, z)
    }
    return null
  }

  private instanced(geometry: THREE.BufferGeometry, material: THREE.Material, count: number) {
    const mesh = new THREE.InstancedMesh(geometry, material, count)
    mesh.castShadow = mesh.receiveShadow = true
    mesh.raycast = () => {}
    this.group.add(mesh)
    return mesh
  }

  private scatter(
    geometry: THREE.BufferGeometry,
    color: number,
    count: number,
    min: number,
    max: number,
    [small, big]: [number, number],
    { wind = 0, sink = 0, spin = false } = {},
  ) {
    const material = enchant(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, flatShading: true }), { wind })
    const mesh = this.instanced(geometry, material, count)
    const matrix = new THREE.Matrix4(),
      tint = new THREE.Color()
    let n = 0
    for (let i = 0; i < count; i++) {
      const at = this.spot(min, max, 0.6)
      if (!at) continue
      const s = lerp(small, big, this.rand())
      const rotation = new THREE.Euler(spin ? this.rand() * TAU : 0, this.rand() * TAU, spin ? this.rand() * TAU : 0)
      matrix.compose(at.setY(at.y - sink * s), new THREE.Quaternion().setFromEuler(rotation), new THREE.Vector3(s, s * lerp(0.7, 1.2, this.rand()), s))
      mesh.setMatrixAt(n, matrix)
      mesh.setColorAt(n++, tint.set(color).offsetHSL((this.rand() - 0.5) * 0.04, 0, (this.rand() - 0.5) * 0.12))
    }
    mesh.count = n
  }

  private plantTrees() {
    const kinds = [
      { parts: conifer(), leaves: 0x2f5d3a },
      { parts: broadleaf(), leaves: 0x4e8a3c },
    ]
    const count = 260
    const meshes = kinds.map(({ parts }) => ({
      trunk: this.instanced(parts.trunk, enchant(new THREE.MeshStandardMaterial({ color: 0x6b4a32, roughness: 1 }), { wind: 0.02 }), count),
      leaves: this.instanced(parts.leaves, enchant(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, flatShading: true }), { wind: 0.05 }), count),
      n: 0,
    }))
    const matrix = new THREE.Matrix4(),
      tint = new THREE.Color()
    for (let i = 0; i < count; i++) {
      const at = this.spot(2.2, REACH, 1.3)
      if (!at) continue
      const d = offBoard(at.x, at.z)
      // Few small trees near the board so they don't hide it, a forest further out
      if (this.rand() > smoothstep(d, 1.5, 9)) continue
      const kind = this.rand() < 0.55 ? 0 : 1
      const m = meshes[kind]
      const s = lerp(0.7, 1.15, this.rand()) * (0.75 + Math.min(d, 20) * 0.04)
      matrix.compose(at.setY(at.y - 0.05), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.rand() * TAU), new THREE.Vector3(s, s * lerp(0.85, 1.25, this.rand()), s))
      m.trunk.setMatrixAt(m.n, matrix)
      m.leaves.setMatrixAt(m.n, matrix)
      m.leaves.setColorAt(m.n++, tint.set(kinds[kind].leaves).offsetHSL((this.rand() - 0.5) * 0.06, (this.rand() - 0.5) * 0.1, (this.rand() - 0.5) * 0.1))
    }
    for (const m of meshes) m.trunk.count = m.leaves.count = m.n
  }

  private plantFlowers() {
    const colors = [0xe8473f, 0xf3c623, 0xf4f1ea, 0xa25ad8, 0xf28ab3, 0x5aa0f0]
    const count = 420
    const stems = this.instanced(new THREE.CylinderGeometry(0.006, 0.008, 0.16, 4).translate(0, 0.08, 0), enchant(new THREE.MeshStandardMaterial({ color: 0x4c8a3a }), { wind: 0.9 }), count)
    const heads = this.instanced(
      new THREE.IcosahedronGeometry(0.035, 0).scale(1, 0.6, 1).translate(0, 0.165, 0),
      enchant(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, emissive: 0x111111 }), { wind: 0.9 }),
      count,
    )
    stems.castShadow = heads.castShadow = false
    const matrix = new THREE.Matrix4(),
      tint = new THREE.Color()
    let n = 0
    for (let patch = 0; patch < 40 && n < count; patch++) {
      // Flowers grow in patches of one colour
      const centre = this.spot(0.4, 18, 0.6)
      if (!centre) continue
      const color = colors[Math.floor(this.rand() * colors.length)]
      for (let k = 0; k < 11 && n < count; k++) {
        const x = centre.x + (this.rand() - 0.5) * 1.4,
          z = centre.z + (this.rand() - 0.5) * 1.4
        const y = this.ground(x, z)
        if (offBoard(x, z) < 0.3 || y < this.waterLevel + 0.05) continue
        const s = lerp(0.8, 1.4, this.rand())
        matrix.compose(new THREE.Vector3(x, y, z), new THREE.Quaternion(), new THREE.Vector3(s, s, s))
        stems.setMatrixAt(n, matrix)
        heads.setMatrixAt(n, matrix)
        heads.setColorAt(n++, tint.set(color))
      }
    }
    stems.count = heads.count = n
  }

  // ---------------------------------------------------------------- animals

  /** A flock wheeling high over the land */
  private addBirds() {
    const material = enchant(new THREE.MeshStandardMaterial({ color: 0x2a2a30, side: THREE.DoubleSide, flatShading: true }), { fade: false })
    const wing = new THREE.BufferGeometry()
    wing.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0.09, 0, 0, -0.07, 0.32, 0, -0.02], 3))
    wing.computeVertexNormals()
    const flocks = [
      { radius: 16, height: 9, speed: 0.12, count: 7 },
      { radius: 26, height: 14, speed: -0.07, count: 5 },
    ]
    for (const flock of flocks) {
      const birds = Array.from({ length: flock.count }, (_, i) => {
        const bird = new THREE.Group()
        const body = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.3, 5).rotateX(Math.PI / 2), material)
        const left = new THREE.Mesh(wing, material),
          right = new THREE.Mesh(wing, material)
        right.scale.x = -1
        bird.add(body, left, right)
        this.group.add(bird)
        return { bird, left, right, offset: new THREE.Vector3((this.rand() - 0.5) * 3, (this.rand() - 0.5) * 1.5, (this.rand() - 0.5) * 3), phase: i * 1.3 }
      })
      const start = this.rand() * TAU
      this.animals.push({
        update: (time) => {
          const a = start + time * flock.speed
          const centre = new THREE.Vector3(Math.cos(a) * flock.radius, flock.height + Math.sin(time * 0.3) * 1.5, Math.sin(a) * flock.radius)
          const heading = Math.atan2(-Math.sin(a) * Math.sign(flock.speed), Math.cos(a) * Math.sign(flock.speed))
          for (const b of birds) {
            b.bird.position.copy(centre).add(b.offset)
            b.bird.position.y += Math.sin(time * 0.9 + b.phase) * 0.3
            b.bird.rotation.set(0, heading, 0)
            // Flaps, then glides
            const flap = Math.sin(time * 9 + b.phase) * (0.5 + 0.5 * Math.max(0, Math.sin(time * 0.6 + b.phase)))
            b.left.rotation.z = flap * 0.7
            b.right.rotation.z = -flap * 0.7
          }
        },
      })
    }
  }

  private addButterflies() {
    const colors = [0xffb03b, 0x7fd0ff, 0xffffff, 0xff7ad9, 0xfff06a]
    const wing = new THREE.CircleGeometry(0.06, 6).translate(0.055, 0, 0).rotateX(-Math.PI / 2)
    for (let i = 0; i < 10; i++) {
      const home = this.spot(0.3, 7, 0.3)
      if (!home) continue
      const material = enchant(new THREE.MeshStandardMaterial({ color: colors[i % colors.length], side: THREE.DoubleSide, emissive: colors[i % colors.length], emissiveIntensity: 0.2 }))
      const fly = new THREE.Group()
      const left = new THREE.Mesh(wing, material),
        right = new THREE.Mesh(wing, material)
      right.scale.x = -1
      fly.add(left, right)
      this.group.add(fly)
      const phase = this.rand() * 100,
        range = 0.8 + this.rand() * 1.4
      const last = new THREE.Vector3()
      this.animals.push({
        update: (time) => {
          const t = time * 0.5 + phase
          const x = home.x + Math.sin(t * 1.3) * range + Math.sin(t * 3.1) * 0.2,
            z = home.z + Math.cos(t * 0.9) * range + Math.cos(t * 2.7) * 0.2
          // Never over the board
          const cx = Math.abs(x) < HALF + 0.2 && Math.abs(z) < HALF + 0.2 ? Math.sign(x) * (HALF + 0.2) : x
          fly.position.set(cx, this.ground(cx, z) + 0.45 + Math.sin(t * 4) * 0.15, z)
          const dir = fly.position.clone().sub(last)
          if (dir.lengthSq() > 1e-8) fly.rotation.y = Math.atan2(dir.x, dir.z)
          last.copy(fly.position)
          const flap = Math.sin(time * 22 + phase) * 1.1
          left.rotation.z = flap
          right.rotation.z = -flap
        },
      })
    }
  }

  private addRabbits() {
    const fur = enchant(new THREE.MeshStandardMaterial({ color: 0xa8876a, roughness: 1, flatShading: true }))
    const white = enchant(new THREE.MeshStandardMaterial({ color: 0xf4efe6, roughness: 1 }))
    for (let i = 0; i < 5; i++) {
      const start = this.spot(1, 12)
      if (!start) continue
      const rabbit = new THREE.Group()
      const model = new THREE.Group()
      const body = new THREE.Mesh(new THREE.IcosahedronGeometry(0.1, 1).scale(0.85, 0.8, 1.15), fur)
      body.position.y = 0.09
      const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.065, 1), fur)
      head.position.set(0, 0.17, 0.1)
      const ears = [-1, 1].map((side) => {
        const ear = new THREE.Mesh(new THREE.CapsuleGeometry(0.015, 0.08, 2, 6), fur)
        ear.position.set(side * 0.025, 0.25, 0.08)
        ear.rotation.set(-0.3, 0, side * 0.2)
        return ear
      })
      const tail = new THREE.Mesh(new THREE.IcosahedronGeometry(0.03, 0), white)
      tail.position.set(0, 0.1, -0.12)
      model.add(body, head, ...ears, tail)
      for (const part of model.children) part.castShadow = true
      rabbit.add(model)
      rabbit.position.copy(start)
      this.group.add(rabbit)

      let from = start.clone(),
        to = start.clone(),
        hops = 0,
        clock = this.rand() * 3
      const HOP = 0.32
      this.animals.push({
        update: (time, dt) => {
          clock -= dt
          if (hops === 0 && clock <= 0) {
            // A few hops somewhere nearby, then a rest
            const angle = this.rand() * TAU
            const target = new THREE.Vector3(from.x + Math.cos(angle) * 1.5, 0, from.z + Math.sin(angle) * 1.5)
            const d = offBoard(target.x, target.z)
            const y = this.ground(target.x, target.z)
            if (d > 0.8 && d < 14 && y > this.waterLevel + 0.08) {
              to = target.setY(y)
              hops = 3 + Math.floor(this.rand() * 3)
              rabbit.rotation.y = Math.atan2(to.x - from.x, to.z - from.z)
            }
            clock = hops ? HOP : 1 + this.rand() * 3
          }
          if (hops > 0) {
            const s = 1 - Math.max(clock, 0) / HOP
            const step = 1 / hops
            const p = from.clone().lerp(to, step * s)
            p.y = this.ground(p.x, p.z) + Math.sin(s * Math.PI) * 0.18
            rabbit.position.copy(p)
            model.rotation.x = -0.4 * Math.cos(s * Math.PI)
            if (clock <= 0) {
              from = from.clone().lerp(to, step)
              from.y = this.ground(from.x, from.z)
              hops--
              clock = hops ? HOP : 1 + this.rand() * 4
              model.rotation.x = 0
            }
          } else {
            // Ears twitch while it rests
            ears[0].rotation.z = -0.2 + Math.max(0, Math.sin(time * 3 + i)) * 0.15
          }
        },
      })
    }
  }

  /** Fish leaping out of the lakes now and then, with a splash */
  private addFish() {
    const scales = enchant(new THREE.MeshStandardMaterial({ color: 0xff8a3d, metalness: 0.4, roughness: 0.4 }))
    const ringMaterial = enchant(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false }))
    const lakes: THREE.Vector3[] = []
    for (let tries = 0; tries < 400 && lakes.length < 6; tries++) {
      const x = (this.rand() - 0.5) * 50,
        z = (this.rand() - 0.5) * 50
      if (offBoard(x, z) < 1.5) continue
      if (this.ground(x, z) < this.waterLevel - 0.25) lakes.push(new THREE.Vector3(x, this.waterLevel, z))
    }
    for (const [i, lake] of lakes.entries()) {
      const fish = new THREE.Mesh(new THREE.IcosahedronGeometry(0.08, 1).scale(0.6, 0.7, 1.6), scales)
      const tail = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.1, 3).rotateX(-Math.PI / 2).translate(0, 0, -0.16), scales)
      fish.add(tail)
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.1, 0.14, 24).rotateX(-Math.PI / 2), ringMaterial.clone())
      ring.raycast = fish.raycast = () => {}
      this.group.add(fish, ring)
      let clock = 2 + this.rand() * 6 + i,
        heading = 0,
        splash = 0
      const LEAP = 0.9
      this.animals.push({
        update: (_time, dt) => {
          clock -= dt
          const dir = new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading))
          if (clock <= 0) {
            // Back in the water: ripples spread where it went in
            splash = 1
            ring.position.copy(lake).addScaledVector(dir, 0.45).setY(lake.y + 0.01)
            clock = 5 + this.rand() * 8
            heading = this.rand() * TAU
          }
          fish.visible = clock < LEAP
          if (fish.visible) {
            const k = 1 - clock / LEAP
            fish.position.copy(lake).addScaledVector(dir, (k - 0.5) * 0.9)
            fish.position.y += Math.sin(k * Math.PI) * 0.7 - 0.05
            fish.rotation.set(-Math.cos(k * Math.PI) * 1.1, heading, 0)
          }
          splash = Math.max(0, splash - dt / 0.9)
          ring.visible = splash > 0
          ring.scale.setScalar(1 + (1 - splash) * 5)
          ;(ring.material as THREE.MeshBasicMaterial).opacity = splash
        },
      })
    }
  }

  /** Specks of light drifting over the land */
  private addMotes() {
    const count = 220
    const base = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      const angle = this.rand() * TAU,
        r = HALF + 0.5 + this.rand() * 14
      const x = Math.cos(angle) * r,
        z = Math.sin(angle) * r
      base.set([x, this.ground(x, z) + 0.3 + this.rand() * 2.5, z], i * 3)
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute("position", new THREE.BufferAttribute(base.slice(), 3))
    const material = new THREE.PointsMaterial({
      map: softDot(32, 1.6),
      color: 0xfff2b0,
      size: 0.09,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    const points = new THREE.Points(geo, material)
    points.raycast = () => {}
    this.group.add(points)
    const pos = geo.attributes.position as THREE.BufferAttribute
    this.animals.push({
      update: (time) => {
        for (let i = 0; i < count; i++) {
          const k = i * 3
          pos.setXYZ(i, base[k] + Math.sin(time * 0.3 + i) * 0.4, base[k + 1] + Math.sin(time * 0.5 + i * 1.7) * 0.25, base[k + 2] + Math.cos(time * 0.25 + i * 0.7) * 0.4)
        }
        pos.needsUpdate = true
        material.opacity = 0.75 + Math.sin(time * 1.3) * 0.15
      },
    })
  }
}

// ------------------------------------------------------------------ plant shapes (base at y = 0)

function conifer() {
  const trunk = new THREE.CylinderGeometry(0.05, 0.08, 0.5, 6).translate(0, 0.25, 0)
  const tiers = [0, 1, 2].map((i) => new THREE.ConeGeometry(0.45 - i * 0.11, 0.6, 7).translate(0, 0.55 + i * 0.32, 0))
  return { trunk, leaves: mergeGeometries(tiers) }
}

function broadleaf() {
  const trunk = new THREE.CylinderGeometry(0.05, 0.09, 0.7, 6).translate(0, 0.35, 0)
  const crown = [
    [0, 1.0, 0, 0.42],
    [0.22, 0.85, 0.1, 0.3],
    [-0.18, 0.9, -0.12, 0.32],
  ].map(([x, y, z, r]) => jitter(new THREE.IcosahedronGeometry(r, 1), 0.06).translate(x, y, z))
  return { trunk, leaves: mergeGeometries(crown) }
}

function bushGeometry() {
  return mergeGeometries([
    jitter(new THREE.IcosahedronGeometry(0.2, 1), 0.04).translate(0, 0.12, 0),
    jitter(new THREE.IcosahedronGeometry(0.14, 1), 0.03).translate(0.15, 0.08, 0.05),
  ])
}

function rockGeometry() {
  return jitter(new THREE.DodecahedronGeometry(0.22, 0), 0.06).scale(1, 0.65, 0.9).translate(0, 0.1, 0)
}

/** A tuft of three blades */
function grassGeometry() {
  const blades = [0, 1, 2].map((i) => {
    const g = new THREE.BufferGeometry()
    const a = (i / 3) * Math.PI + 0.3,
      lean = 0.04 * (i - 1)
    const cx = Math.cos(a) * 0.025,
      cz = Math.sin(a) * 0.025
    g.setAttribute("position", new THREE.Float32BufferAttribute([-cx, 0, -cz, cx, 0, cz, lean, 0.14 + i * 0.03, lean * 0.5], 3))
    g.computeVertexNormals()
    return g
  })
  return mergeGeometries(blades)
}

/** Roughens a shape by moving each vertex a little (shared corners move together) */
function jitter(geo: THREE.BufferGeometry, amount: number) {
  const pos = geo.attributes.position
  const moved = new Map<string, THREE.Vector3>()
  for (let i = 0; i < pos.count; i++) {
    const key = `${pos.getX(i).toFixed(3)},${pos.getY(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`
    if (!moved.has(key)) {
      const h = Math.sin(pos.getX(i) * 91.7 + pos.getY(i) * 47.3 + pos.getZ(i) * 13.1) * 43758.5453
      const r = h - Math.floor(h)
      moved.set(key, new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)).multiplyScalar(1 + (r - 0.5) * 2 * (amount / 0.2)))
    }
    const v = moved.get(key)!
    pos.setXYZ(i, v.x, v.y, v.z)
  }
  geo.computeVertexNormals()
  return geo
}
