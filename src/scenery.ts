import * as THREE from "three"
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js"
import { cellAt, N, type Seat } from "../shared/rules"

// Procedural textures and the landscape around the board: outer terrain, side walls, goal light barriers

export const STEP = 0.35 // world height of one terrain unit
export const BASE = 0.4
export const TEAM_COLORS = [0xd8443a, 0x3a7bd8]
const HEIGHT_COLORS = [0x2f6f8f, 0x4f9a6a, 0x7fb45a, 0xb7b25b, 0xa47c4a, 0x8a6a55, 0x8f8f94, 0xc4c4cc, 0xf1f1f5].map(
  (c) => new THREE.Color(c),
)
const OUTER_SIZE = 90
const BARRIER_HEIGHT = 3.4
/** Brighter than the team colours so the light reads against the dark haze */
const BARRIER_COLORS = [0xff5a3c, 0x4aa8ff]
const BARRIER_REACH = 40

/** Half-width of the flat top of each square; the rest of the square slopes toward its neighbours */
const PLATEAU = 0.25

const { smoothstep, lerp, clamp } = THREE.MathUtils

function hash(x: number, y: number, seed: number) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 2246822519)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/** Smooth value noise in [0, 1]; with a period it tiles (for textures) */
function noise(x: number, y: number, seed = 0, period = 0) {
  const xi = Math.floor(x),
    yi = Math.floor(y)
  const fx = x - xi,
    fy = y - yi
  const ux = fx * fx * (3 - 2 * fx),
    uy = fy * fy * (3 - 2 * fy)
  const wrap = (v: number) => (period ? ((v % period) + period) % period : v)
  const at = (dx: number, dy: number) => hash(wrap(xi + dx), wrap(yi + dy), seed)
  return lerp(lerp(at(0, 0), at(1, 0), ux), lerp(at(0, 1), at(1, 1), ux), uy)
}

function fbm(x: number, y: number, octaves: number, seed = 0, period = 0) {
  let sum = 0,
    amp = 0.5,
    norm = 0
  for (let o = 0; o < octaves; o++) {
    const f = 2 ** o
    sum += noise(x * f, y * f, seed + o, period * f) * amp
    norm += amp
    amp /= 2
  }
  return sum / norm
}

function canvasTexture(width: number, height: number, value: (x: number, y: number) => number) {
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext("2d")!
  const img = ctx.createImageData(width, height)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const v = clamp(value(x, y), 0, 1) * 255
      const i = (y * width + x) * 4
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v
      img.data[i + 3] = 255
    }
  ctx.putImageData(img, 0, 0)
  const texture = new THREE.CanvasTexture(canvas)
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping
  return texture
}

/** Grainy, tileable ground detail: multiplies the terrain colour and doubles as a bump map */
export function makeGroundTexture() {
  const size = 256
  const texture = canvasTexture(size, size, (x, y) => {
    const u = x / size,
      v = y / size
    const grain = fbm(u * 8, v * 8, 5, 11, 8)
    const pebbles = noise(u * 48, v * 48, 23, 48)
    return 0.62 + grain * 0.32 + (pebbles > 0.78 ? 0.08 : 0)
  })
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

/** Vertical light streaks for the barriers (scrolls upward) and their bottom-bright fade */
function makeBarrierTextures() {
  const streaks = canvasTexture(256, 128, (x, y) => {
    const s = fbm(x / 9, y / 64, 3, 5, 0) * fbm(x / 23, 0.5, 2, 9, 0)
    return 0.15 + Math.pow(s, 1.5) * 2.4
  })
  streaks.colorSpace = THREE.SRGBColorSpace
  const fade = canvasTexture(4, 128, (_x, y) => {
    const v = 1 - y / 127 // canvas rows go top to bottom
    return Math.pow(1 - v, 1.8) * 0.85 + (v < 0.06 ? 0.15 : 0)
  })
  fade.wrapS = fade.wrapT = THREE.ClampToEdgeWrapping
  return { streaks, fade }
}

export function heightColor(level: number) {
  const i = clamp(level, 0, HEIGHT_COLORS.length - 1)
  const lo = Math.floor(i),
    hi = Math.min(lo + 1, HEIGHT_COLORS.length - 1)
  return HEIGHT_COLORS[lo].clone().lerp(HEIGHT_COLORS[hi], i - lo)
}

/**
 * How much each nearby square contributes at a world position on the board. Inside a square's plateau it's
 * all that square; across an edge the weights ease from one square to the next and meet half-way on the edge,
 * so the ground is continuous with slopes instead of cliffs.
 */
export function boardWeights(x: number, z: number): { cell: number; w: number }[] {
  const half = N / 2
  const axis = (v: number) => {
    const g = clamp(v + half, 0, N - 1e-6)
    const i = Math.floor(g)
    const u = g - i - 0.5
    const t = Math.max(Math.abs(u) - PLATEAU, 0) / (0.5 - PLATEAU) / 2
    const next = clamp(i + Math.sign(u), 0, N - 1)
    return { i, next, w: t * t * (3 - 2 * t) }
  }
  const ax = axis(x),
    az = axis(z)
  return [
    { cell: cellAt(ax.i, az.i), w: (1 - ax.w) * (1 - az.w) },
    { cell: cellAt(ax.next, az.i), w: ax.w * (1 - az.w) },
    { cell: cellAt(ax.i, az.next), w: (1 - ax.w) * az.w },
    { cell: cellAt(ax.next, az.next), w: ax.w * az.w },
  ]
}

export function boardHeight(heights: number[], x: number, z: number) {
  return boardWeights(x, z).reduce((sum, { cell, w }) => sum + (BASE + heights[cell] * STEP) * w, 0)
}

/** Height of the landscape at a world position: continues the board's edge, then rolls into hills */
function outerHeight(heights: number[], x: number, z: number) {
  const half = N / 2
  if (Math.abs(x) < half && Math.abs(z) < half) return -0.05 // hidden under the board
  const edge = boardHeight(heights, clamp(x, -half, half), clamp(z, -half, half)) - 0.03
  const d = Math.hypot(Math.max(Math.abs(x) - half, 0), Math.max(Math.abs(z) - half, 0))
  // Gentle rolling ground near the board, bigger hills only far away in the haze
  const rolling = BASE + (fbm(x * 0.08, z * 0.08, 4, 3) - 0.35) * 2.2
  const hills = Math.pow(fbm(x * 0.04, z * 0.04, 3, 7), 2) * 9 * smoothstep(d, 10, 35)
  return lerp(edge, rolling, smoothstep(d, 0, 3.5)) + hills
}

/** Where a goal barrier runs: straight along the board, wandering once it leaves it */
function barrierZ(seat: Seat, x: number) {
  const side = seat === 0 ? 1 : -1
  const away = smoothstep(Math.abs(x), N / 2, N / 2 + 4)
  const wander = Math.sin(x * 0.42 + seat * 2.1) * 1.1 + Math.sin(x * 0.15 + seat * 4) * 2.4 + Math.sin(x * 0.9) * 0.25
  return side * (N / 2 + 0.03 + away * Math.max(wander + 1.5, 0.2))
}

export class Scenery {
  readonly group = new THREE.Group()
  private ground = makeGroundTexture()
  private barrier = makeBarrierTextures()
  private barrierMaterials: THREE.MeshBasicMaterial[]

  constructor() {
    this.barrierMaterials = BARRIER_COLORS.map((color) => {
      return new THREE.MeshBasicMaterial({
        color,
        map: this.barrier.streaks,
        alphaMap: this.barrier.fade,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
    })
  }

  /** Material for the board ground: vertex colours over the ground grain */
  boardMaterial() {
    const map = this.ground.clone()
    map.repeat.set(N / 1.5, N / 1.5)
    return new THREE.MeshStandardMaterial({ vertexColors: true, map, bumpMap: map, bumpScale: 1.2, roughness: 0.92 })
  }

  build(heights: number[]) {
    this.group.clear()
    this.group.add(this.buildOuterTerrain(heights), this.buildSideWalls(heights))
    for (const seat of [0, 1] as Seat[]) this.group.add(this.buildBarrier(heights, seat))
  }

  private buildOuterTerrain(heights: number[]) {
    const segments = OUTER_SIZE * 2 // vertices every 0.5 so the board edges land on grid lines
    const geo = new THREE.PlaneGeometry(OUTER_SIZE, OUTER_SIZE, segments, segments).rotateX(-Math.PI / 2)
    const pos = geo.attributes.position
    const colors = new Float32Array(pos.count * 3)
    const color = new THREE.Color()
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i),
        z = pos.getZ(i)
      const y = outerHeight(heights, x, z)
      pos.setY(i, y)
      // Same palette as the board, a bit duller so the play area stands out
      color.copy(heightColor((y - BASE) / STEP)).multiplyScalar(0.78 + fbm(x * 0.3, z * 0.3, 2, 17) * 0.12)
      color.toArray(colors, i * 3)
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3))
    geo.computeVertexNormals()
    const map = this.ground.clone()
    map.repeat.set(OUTER_SIZE / 1.5, OUTER_SIZE / 1.5)
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, map, bumpMap: map, roughness: 1 }))
    mesh.receiveShadow = true
    return mesh
  }

  /** Low stone walls along the two sides that can't be crossed */
  private buildSideWalls(heights: number[]) {
    const group = new THREE.Group()
    const material = new THREE.MeshStandardMaterial({ color: 0x77716a, map: this.ground, bumpMap: this.ground, bumpScale: 2, roughness: 0.95 })
    for (const side of [-1, 1]) {
      for (let y = 0; y < N; y++) {
        const h = boardHeight(heights, side * (N / 2), y - N / 2 + 0.5) + 0.3
        const block = new THREE.Mesh(roundedBox(0.3, h, 0.94, 0.08), material)
        block.position.set(side * (N / 2 + 0.2), 0, y - N / 2 + 0.5)
        block.castShadow = block.receiveShadow = true
        group.add(block)
      }
    }
    return group
  }

  /** A curtain of light rising along the goal edge, carrying on off the board */
  private buildBarrier(heights: number[], seat: Seat) {
    const positions: number[] = [],
      uvs: number[] = [],
      indices: number[] = []
    let length = 0,
      prev: THREE.Vector3 | null = null
    const step = 0.25
    for (let x = -BARRIER_REACH; x <= BARRIER_REACH + 1e-6; x += step) {
      const z = barrierZ(seat, x)
      const ground = outerHeight(heights, x, z)
      const point = new THREE.Vector3(x, ground - 0.25, z)
      if (prev) length += point.distanceTo(prev)
      prev = point
      const top = BARRIER_HEIGHT * (0.85 + fbm(x * 0.2, seat * 10, 2, 31) * 0.3)
      positions.push(point.x, point.y, point.z, point.x, point.y + top, point.z)
      uvs.push(length / 6, 0, length / 6, 1)
      const i = positions.length / 3 - 2
      if (i >= 2) indices.push(i - 2, i - 1, i, i - 1, i + 1, i)
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3))
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2))
    geo.setIndex(indices)
    const mesh = new THREE.Mesh(geo, this.barrierMaterials[seat])
    mesh.renderOrder = 5
    return mesh
  }

  update(time: number) {
    this.barrier.streaks.offset.set(time * 0.02, -time * 0.25)
    for (const [seat, material] of this.barrierMaterials.entries()) material.opacity = 0.85 + Math.sin(time * 1.7 + seat * 3) * 0.15
  }
}

/** A box with softened edges, its base at y = 0 */
function roundedBox(width: number, height: number, depth: number, radius: number) {
  return new RoundedBoxGeometry(width, height, depth, 3, radius).translate(0, height / 2, 0)
}
