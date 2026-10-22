import * as THREE from "three"
import { cellAt, N } from "../shared/rules"
import { EDGE_FADE_UNIFORMS, EDGE_FADE_VERTEX, sceneUniforms } from "./shading"

// Water: it fills the lowest (blue) squares of the board and the hollows of the landscape at the same level,
// rippling and running over them, with foam where it meets the ground.

/** How deep the water stands over the lowest squares */
const WATER_DEPTH = 0.07
/** Vertices per square of the board's water (for a smooth shoreline) */
const DIVISIONS = 10

const vertexShader = /* glsl */ `
  ${EDGE_FADE_UNIFORMS}
  attribute float depth;
  varying float vDepth;
  varying vec2 vPos;
  void main() {
    vDepth = depth;
    vPos = position.xz;
    vec4 enchantWorld = modelMatrix * vec4(position, 1.0);
    ${EDGE_FADE_VERTEX}
    gl_Position = projectionMatrix * viewMatrix * enchantWorld;
  }
`

const fragmentShader = /* glsl */ `
  uniform float uTime;
  uniform float uBoardHole;
  uniform float uHalf;
  varying float vEdgeFade;
  varying float vDepth;
  varying vec2 vPos;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }

  void main() {
    // The board has its own, finer water
    if (uBoardHole > 0.5 && abs(vPos.x) < uHalf && abs(vPos.y) < uHalf) discard;
    float t = uTime;
    float ripple = noise(vPos * 3.0 + vec2(t * 0.35, t * 0.22)) * 0.6 + noise(vPos * 6.0 - vec2(t * 0.28, -t * 0.4)) * 0.4;
    // Runnels streaming across
    float run = pow(noise(vec2(vPos.x * 2.5 + sin(vPos.y * 1.7) * 0.4, vPos.y * 9.0 - t * 1.8)), 4.0);
    float shallow = 1.0 - smoothstep(0.0, 0.3, vDepth);
    vec3 color = mix(vec3(0.04, 0.24, 0.4), vec3(0.12, 0.48, 0.6), shallow * 0.7 + ripple * 0.25);
    color += vec3(0.75, 0.9, 1.0) * (smoothstep(0.68, 0.86, ripple) * 0.35 + run * 0.45);
    float foam = (1.0 - smoothstep(0.0, 0.025, vDepth)) * (0.5 + 0.5 * noise(vPos * 14.0 + t)) * 0.8;
    color = mix(color, vec3(0.95), foam);
    float alpha = mix(0.62, 0.85, 1.0 - shallow) + foam * 0.3;
    gl_FragColor = vec4(color, min(alpha, 1.0) * vEdgeFade);
    #include <colorspace_fragment>
  }
`

function waterMaterial(boardHole: boolean) {
  return new THREE.ShaderMaterial({
    uniforms: { ...sceneUniforms, uBoardHole: { value: boardHole ? 1 : 0 }, uHalf: { value: N / 2 } },
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
  })
}

export function waterLevel(base: number) {
  return base + WATER_DEPTH
}

/** The lakes of the landscape sit lower, so only real hollows fill up */
export const LAKE_DROP = 0.25

function finish(geo: THREE.BufferGeometry, material: THREE.ShaderMaterial) {
  const mesh = new THREE.Mesh(geo, material)
  // After the land (transparent, see shading.ts) and before the move highlights, which stay readable on top
  mesh.renderOrder = -1
  mesh.raycast = () => {}
  return mesh
}

/** Water over the board's lowest squares */
export function boardWater(heights: number[], level: number, ground: (x: number, z: number) => number) {
  const positions: number[] = [],
    depths: number[] = [],
    indices: number[] = []
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      if (heights[cellAt(x, y)] !== 0) continue
      const first = positions.length / 3
      for (let j = 0; j <= DIVISIONS; j++)
        for (let i = 0; i <= DIVISIONS; i++) {
          const px = x - N / 2 + i / DIVISIONS,
            pz = y - N / 2 + j / DIVISIONS
          positions.push(px, level, pz)
          depths.push(level - ground(px, pz))
        }
      for (let j = 0; j < DIVISIONS; j++)
        for (let i = 0; i < DIVISIONS; i++) {
          const a = first + j * (DIVISIONS + 1) + i
          indices.push(a, a + DIVISIONS + 1, a + 1, a + 1, a + DIVISIONS + 1, a + DIVISIONS + 2)
        }
    }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3))
  geo.setAttribute("depth", new THREE.Float32BufferAttribute(depths, 1))
  geo.setIndex(indices)
  return finish(geo, waterMaterial(false))
}

/** Lakes in the hollows of the landscape */
export function landWater(size: number, level: number, ground: (x: number, z: number) => number) {
  const geo = new THREE.PlaneGeometry(size, size, size * 2, size * 2).rotateX(-Math.PI / 2)
  const pos = geo.attributes.position
  const depths = new Float32Array(pos.count)
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, level)
    depths[i] = level - ground(pos.getX(i), pos.getZ(i))
  }
  geo.setAttribute("depth", new THREE.BufferAttribute(depths, 1))
  return finish(geo, waterMaterial(true))
}
