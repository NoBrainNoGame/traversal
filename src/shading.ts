import * as THREE from "three"

// Shader additions shared by the landscape: wind sway, and the fade that makes the ground and everything on it
// turn transparent toward the edge of the world, instead of fog.

export const sceneUniforms = {
  uTime: { value: 0 },
  /** From the scene to the board's own space (the board is centred on its origin) */
  uEdgeInverse: { value: new THREE.Matrix4() },
  /** Distance from the board's centre where the fade starts, and where nothing is left */
  uEdgeRange: { value: new THREE.Vector2(22, 45) },
}

/** GLSL computing vEdgeFade from a position in the scene (after `#include <project_vertex>`) */
export const EDGE_FADE_VERTEX = /* glsl */ `
  vEdgeFade = 1.0 - smoothstep(uEdgeRange.x, uEdgeRange.y, length((uEdgeInverse * enchantWorld).xz));
`
export const EDGE_FADE_UNIFORMS = /* glsl */ `
  uniform float uTime;
  uniform mat4 uEdgeInverse;
  uniform vec2 uEdgeRange;
  varying float vEdgeFade;
`

/**
 * Adds the edge fade (and some wind, for plants: how far their tops sway) to a built-in three.js material.
 * Faded materials become transparent.
 */
export function enchant<M extends THREE.Material>(material: M, { wind = 0, fade = true } = {}): M {
  if (fade) material.transparent = true
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, sceneUniforms)
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${EDGE_FADE_UNIFORMS}`)
      .replace(
        "#include <begin_vertex>",
        /* glsl */ `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vec2 enchantSeed = instanceMatrix[3].xz;
        #else
          vec2 enchantSeed = modelMatrix[3].xz;
        #endif
        float enchantSway = ${wind.toFixed(3)} * pow(max(transformed.y, 0.0), 1.5);
        transformed.x += enchantSway * sin(uTime * 1.6 + enchantSeed.x * 0.7 + enchantSeed.y * 0.3);
        transformed.z += enchantSway * 0.5 * cos(uTime * 1.1 + enchantSeed.y * 0.6);`,
      )
      .replace(
        "#include <project_vertex>",
        /* glsl */ `#include <project_vertex>
        vec4 enchantWorld = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          enchantWorld = instanceMatrix * enchantWorld;
        #endif
        enchantWorld = modelMatrix * enchantWorld;
        ${EDGE_FADE_VERTEX}`,
      )
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vEdgeFade;")
      .replace("#include <dithering_fragment>", `#include <dithering_fragment>\n${fade ? "gl_FragColor.a *= vEdgeFade;" : ""}`)
  }
  material.customProgramCacheKey = () => `enchant:${wind}:${fade}`
  return material
}

/** Seeded random numbers in [0, 1), so a terrain always gets the same trees */
export function random(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A soft round dot (for motes, mist and clouds) */
export function softDot(size = 64, falloff = 2) {
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = size
  const ctx = canvas.getContext("2d")!
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  for (let i = 0; i <= 8; i++) g.addColorStop(i / 8, `rgba(255,255,255,${Math.pow(1 - i / 8, falloff)})`)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}
