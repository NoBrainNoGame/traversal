import * as THREE from "three"
import { random, softDot } from "./shading"

// The far-off fantasy world beyond the land's fading edge: a morning sky, mountain ranges in the haze,
// floating islands pouring waterfalls into the void, glowing crystal spires, drifting clouds, and a ringed
// planet with its moon. Nothing here depends on the board.

const TAU = Math.PI * 2
const SKY_RADIUS = 900
/** Colour of the air far away: everything distant leans toward it */
export const HAZE = new THREE.Color(0xe9c9b4)
const ZENITH = new THREE.Color(0x4566b0)
const MID = new THREE.Color(0x9db5de)

const { lerp } = THREE.MathUtils

/** How much air sits between the viewer and something this far */
const hazeAt = (distance: number) => THREE.MathUtils.clamp(distance / 420, 0.15, 0.85)
const hazy = (color: number, distance: number) => new THREE.Color(color).lerp(HAZE, hazeAt(distance))

export class Landscape {
  readonly group = new THREE.Group()
  private rand = random(1789)
  private islands: { group: THREE.Group; base: number; phase: number }[] = []
  private crystals: THREE.MeshStandardMaterial[] = []
  private falls: THREE.Texture
  private clouds = new THREE.Group()

  constructor() {
    this.falls = waterfallTexture()
    this.group.add(sky(), this.clouds)
    this.group.add(mountains(250, 22, 62, 0xa58fb8, 3), mountains(370, 45, 120, 0xb8a6c8, 11))
    for (let i = 0; i < 7; i++) this.addIsland(i)
    for (let i = 0; i < 6; i++) this.addCrystals()
    this.addPlanet()
    this.addClouds()
    this.group.traverse((o) => (o.raycast = () => {}))
  }

  update(time: number) {
    for (const island of this.islands) {
      island.group.position.y = island.base + Math.sin(time * 0.25 + island.phase) * 1.2
      island.group.rotation.y = island.phase + time * 0.01
    }
    this.falls.offset.y = time * 0.9
    for (const [i, material] of this.crystals.entries()) material.emissiveIntensity = 0.55 + Math.sin(time * 0.8 + i * 1.7) * 0.25
    this.clouds.rotation.y = time * 0.004
  }

  private addIsland(i: number) {
    const angle = (i / 7) * TAU + this.rand() * 0.6
    const distance = lerp(60, 150, this.rand())
    const size = lerp(5, 13, this.rand())
    const group = new THREE.Group()
    const rock = new THREE.Mesh(
      roughen(new THREE.ConeGeometry(size, size * 1.9, 9, 4).rotateX(Math.PI).translate(0, -size * 0.95, 0), size * 0.12, this.rand),
      new THREE.MeshLambertMaterial({ color: hazy(0x7a6152, distance), flatShading: true }),
    )
    const top = new THREE.Mesh(
      roughen(new THREE.CylinderGeometry(size * 1.02, size, size * 0.18, 12, 1), size * 0.05, this.rand),
      new THREE.MeshLambertMaterial({ color: hazy(0x5f9a4a, distance), flatShading: true }),
    )
    group.add(rock, top)
    // A few trees on top
    const leaves = new THREE.MeshLambertMaterial({ color: hazy(0x2f6a3a, distance), flatShading: true })
    for (let k = 0; k < 3 + size / 2; k++) {
      const r = this.rand() * size * 0.75,
        a = this.rand() * TAU
      const h = lerp(1.5, 3.5, this.rand())
      const tree = new THREE.Mesh(new THREE.ConeGeometry(h * 0.35, h, 6).translate(0, h / 2 + size * 0.09, 0), leaves)
      tree.position.set(Math.cos(a) * r, 0, Math.sin(a) * r)
      group.add(tree)
    }
    // A waterfall pouring off its rim, thinning out into the void
    const width = size * lerp(0.15, 0.3, this.rand())
    const length = size * 4
    const fall = new THREE.Mesh(
      new THREE.PlaneGeometry(width, length).translate(0, -length / 2 + size * 0.05, 0),
      new THREE.MeshBasicMaterial({ map: this.falls, alphaMap: fallFade(), color: hazy(0xdff4ff, distance * 0.5), transparent: true, depthWrite: false, side: THREE.DoubleSide }),
    )
    const rim = this.rand() * TAU
    fall.position.set(Math.cos(rim) * size * 0.98, 0, Math.sin(rim) * size * 0.98)
    fall.rotation.y = -rim + Math.PI / 2
    group.add(fall)
    const base = lerp(8, 30, this.rand())
    group.position.set(Math.cos(angle) * distance, base, Math.sin(angle) * distance)
    this.islands.push({ group, base, phase: this.rand() * TAU })
    this.group.add(group)
  }

  /** A cluster of tall glowing crystals rising out of the haze */
  private addCrystals() {
    const angle = this.rand() * TAU,
      distance = lerp(200, 320, this.rand())
    const hue = this.rand() < 0.5 ? 0x7fe8ff : 0xd58cff
    const material = new THREE.MeshStandardMaterial({ color: hazy(hue, distance), emissive: hazy(hue, distance), emissiveIntensity: 0.6, roughness: 0.2, metalness: 0.1, flatShading: true, transparent: true, opacity: 0.8 })
    this.crystals.push(material)
    const cluster = new THREE.Group()
    for (let k = 0; k < 5; k++) {
      const h = lerp(18, 55, this.rand()) * (k === 0 ? 1.3 : 1)
      const r = h * lerp(0.07, 0.12, this.rand())
      const spire = new THREE.Mesh(
        new THREE.CylinderGeometry(0, r, h * 0.25, 6).translate(0, h * 0.875, 0).toNonIndexed(),
        material,
      )
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.1, h * 0.75, 6).translate(0, h * 0.375, 0), material)
      const crystal = new THREE.Group().add(spire, shaft)
      crystal.position.set((this.rand() - 0.5) * 18, -8, (this.rand() - 0.5) * 18)
      crystal.rotation.set((this.rand() - 0.5) * 0.4, this.rand() * TAU, (this.rand() - 0.5) * 0.4)
      cluster.add(crystal)
    }
    cluster.position.set(Math.cos(angle) * distance, 0, Math.sin(angle) * distance)
    this.group.add(cluster)
  }

  private addPlanet() {
    const sky = new THREE.Group()
    const planet = new THREE.Mesh(
      new THREE.SphereGeometry(70, 48, 24),
      new THREE.MeshBasicMaterial({ map: bandTexture(), transparent: true, opacity: 0.75, depthWrite: false }),
    )
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(95, 150, 96),
      new THREE.MeshBasicMaterial({ map: ringTexture(), transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false }),
    )
    // The ring texture runs from the inner to the outer edge
    const uv = ring.geometry.attributes.uv,
      pos = ring.geometry.attributes.position
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (Math.hypot(pos.getX(i), pos.getY(i)) - 95) / 55, 0.5)
    ring.rotation.set(Math.PI / 2 - 0.35, 0.2, 0)
    planet.rotation.z = 0.3
    const moon = new THREE.Mesh(new THREE.SphereGeometry(14, 32, 16), new THREE.MeshBasicMaterial({ color: 0xf3eee8, transparent: true, opacity: 0.7, depthWrite: false }))
    moon.position.set(-190, -60, 40)
    sky.add(planet, ring, moon)
    sky.position.setFromSphericalCoords(700, THREE.MathUtils.degToRad(62), THREE.MathUtils.degToRad(-35))
    sky.lookAt(0, 0, 0)
    for (const o of [planet, ring, moon]) o.renderOrder = -9
    this.group.add(sky)
  }

  private addClouds() {
    const texture = cloudTexture()
    for (let i = 0; i < 26; i++) {
      const material = new THREE.SpriteMaterial({ map: texture, color: 0xffffff, transparent: true, opacity: lerp(0.5, 0.85, this.rand()), depthWrite: false })
      const cloud = new THREE.Sprite(material)
      const distance = lerp(160, 520, this.rand()),
        angle = this.rand() * TAU
      cloud.position.set(Math.cos(angle) * distance, lerp(35, 140, this.rand()), Math.sin(angle) * distance)
      const s = lerp(60, 160, this.rand())
      cloud.scale.set(s * 2.2, s, 1)
      cloud.renderOrder = -8
      material.color.lerp(HAZE, hazeAt(distance) * 0.5)
      this.clouds.add(cloud)
    }
  }
}

// ------------------------------------------------------------------ the sky

function sky() {
  const material = new THREE.ShaderMaterial({
    uniforms: { uZenith: { value: ZENITH }, uMid: { value: MID }, uHaze: { value: HAZE } },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uZenith, uMid, uHaze;
      varying vec3 vDir;
      void main() {
        float h = vDir.y;
        vec3 color = mix(uHaze, uMid, smoothstep(0.0, 0.25, h));
        color = mix(color, uZenith, smoothstep(0.25, 0.9, h));
        // Morning sun low on the horizon
        vec3 sun = normalize(vec3(-0.55, 0.12, -0.8));
        float glow = max(dot(normalize(vDir), sun), 0.0);
        color += vec3(1.0, 0.82, 0.55) * (pow(glow, 8.0) * 0.35 + pow(glow, 400.0) * 1.2);
        gl_FragColor = vec4(color, 1.0);
        #include <colorspace_fragment>
      }
    `,
    side: THREE.BackSide,
    depthWrite: false,
  })
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(SKY_RADIUS, 48, 24), material)
  mesh.renderOrder = -10
  return mesh
}

/** A range of peaks all around, snow on the highest, fading into the haze at their feet */
function mountains(radius: number, low: number, high: number, color: number, seed: number) {
  const rand = random(seed)
  const steps = 360
  const offsets = Array.from({ length: 6 }, () => rand() * TAU)
  const positions: number[] = [],
    colors: number[] = [],
    indices: number[] = []
  const rock = hazy(color, radius),
    snow = hazy(0xffffff, radius * 0.7),
    foot = HAZE.clone()
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * TAU
    // Sharp ridges: several sines folded into peaks
    let ridge = 0
    for (let k = 0; k < 6; k++) ridge += Math.abs(Math.sin(a * (3 + k * 2.3) + offsets[k])) / (k + 1)
    const h = lerp(low, high, Math.min(ridge / 1.6, 1))
    const x = Math.cos(a) * radius,
      z = Math.sin(a) * radius
    positions.push(x, -30, z, x * 0.995, h * 0.45, z * 0.995, x * 0.99, h, z * 0.99)
    const top = h > high * 0.78 ? snow : rock
    colors.push(foot.r, foot.g, foot.b, rock.r, rock.g, rock.b, top.r, top.g, top.b)
    if (i > 0) {
      const b = i * 3,
        p = b - 3
      indices.push(p, b, p + 1, p + 1, b, b + 1, p + 1, b + 1, p + 2, p + 2, b + 1, b + 2)
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3))
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3))
  geo.setIndex(indices)
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }))
  mesh.renderOrder = -7
  return mesh
}

// ------------------------------------------------------------------ shapes and textures

function roughen(geo: THREE.BufferGeometry, amount: number, rand: () => number) {
  const pos = geo.attributes.position
  const moved = new Map<string, [number, number, number]>()
  for (let i = 0; i < pos.count; i++) {
    const key = `${pos.getX(i).toFixed(2)},${pos.getY(i).toFixed(2)},${pos.getZ(i).toFixed(2)}`
    if (!moved.has(key)) moved.set(key, [(rand() - 0.5) * amount, (rand() - 0.5) * amount, (rand() - 0.5) * amount])
    const [dx, dy, dz] = moved.get(key)!
    pos.setXYZ(i, pos.getX(i) + dx, pos.getY(i) + dy, pos.getZ(i) + dz)
  }
  geo.computeVertexNormals()
  return geo
}

function canvas(width: number, height: number, draw: (ctx: CanvasRenderingContext2D) => void) {
  const c = document.createElement("canvas")
  c.width = width
  c.height = height
  draw(c.getContext("2d")!)
  const texture = new THREE.CanvasTexture(c)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

/** Streaks of falling water (scrolls down) */
function waterfallTexture() {
  const rand = random(7)
  const texture = canvas(64, 256, (ctx) => {
    ctx.fillStyle = "rgb(200,230,255)"
    ctx.fillRect(0, 0, 64, 256)
    for (let i = 0; i < 90; i++) {
      ctx.fillStyle = `rgba(255,255,255,${0.3 + rand() * 0.6})`
      ctx.fillRect(rand() * 64, rand() * 256, 1 + rand() * 3, 20 + rand() * 60)
    }
  })
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping
  texture.repeat.set(1, 2)
  return texture
}

/** Opaque at the rim, gone at the bottom, soft on the sides */
function fallFade() {
  const texture = canvas(32, 128, (ctx) => {
    const v = ctx.createLinearGradient(0, 0, 0, 128)
    v.addColorStop(0, "#fff")
    v.addColorStop(0.5, "#aaa")
    v.addColorStop(1, "#000")
    ctx.fillStyle = v
    ctx.fillRect(0, 0, 32, 128)
    ctx.globalCompositeOperation = "multiply"
    const h = ctx.createLinearGradient(0, 0, 32, 0)
    h.addColorStop(0, "#000")
    h.addColorStop(0.3, "#fff")
    h.addColorStop(0.7, "#fff")
    h.addColorStop(1, "#000")
    ctx.fillStyle = h
    ctx.fillRect(0, 0, 32, 128)
  })
  texture.colorSpace = THREE.NoColorSpace
  return texture
}

function cloudTexture() {
  const dot = softDot(64, 1.4).image as HTMLCanvasElement
  const rand = random(3)
  return canvas(256, 128, (ctx) => {
    for (let i = 0; i < 30; i++) {
      // Puffs kept inside the canvas, so the sprite has no hard edge
      const x = 64 + rand() * 128,
        y = 70 - rand() * 20 + Math.abs(x - 128) * 0.12
      const r = 18 + rand() * (40 - Math.abs(x - 128) * 0.25)
      ctx.globalAlpha = 0.5
      ctx.drawImage(dot, x - r, y - r, r * 2, r * 2)
    }
  })
}

function bandTexture() {
  const rand = random(11)
  return canvas(16, 256, (ctx) => {
    for (let y = 0; y < 256; y += 4) {
      const t = rand()
      ctx.fillStyle = `rgb(${200 + t * 50},${150 + t * 60},${170 + t * 50})`
      ctx.fillRect(0, y, 16, 4 + rand() * 8)
    }
  })
}

function ringTexture() {
  const rand = random(5)
  const texture = canvas(256, 4, (ctx) => {
    for (let x = 0; x < 256; x++) {
      const a = (0.25 + rand() * 0.6) * Math.sin((x / 256) * Math.PI)
      ctx.fillStyle = `rgba(240,225,210,${a})`
      ctx.fillRect(x, 0, 1, 4)
    }
  })
  return texture
}
