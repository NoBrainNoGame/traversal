import * as THREE from "three"
import { BALL_RADIUS, setPieceOpacity, type PieceView } from "./characters"

// How each piece moves and kills, played over time by the board:
// - the sentinel curls into a spiked ball and rolls; to kill, it leaps onto the enemy, crushes it and bounces
//   back down onto the freed square
// - the explorer's goat jumps from square to square; to kill, it lowers its horns and charges, sending the enemy flying
// - the vanguard marches; to kill, it lowers its spear, lunges, and the enemy topples over

/** One piece's action being played */
export interface Motion {
  view: PieceView
  /** Square tops along the way, start included (an exit adds a point off the board) */
  points: THREE.Vector3[]
  attack: boolean
  /** The piece being killed, driven by the attacker's motion until it's gone */
  victim: { id: number; view: PieceView } | null
  /** The piece leaves the board and fades away at the end */
  fadeOut: boolean
  /** Waits for the camera to settle on the piece before starting */
  waitForCamera: boolean
  time: number
  track?: Track
}

/** Ground height at a board position */
export type Ground = (x: number, z: number) => number

const ease = (t: number) => THREE.MathUtils.smoothstep(t, 0, 1)
const clamp01 = (t: number) => THREE.MathUtils.clamp(t, 0, 1)
const FADE = 0.45

/** A path walked at ground level, measured on the board plane */
class Track {
  private lengths: number[] = []
  readonly total: number

  constructor(
    private points: THREE.Vector3[],
    private ground: Ground,
  ) {
    for (let i = 1; i < points.length; i++) this.lengths.push(Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z))
    this.total = this.lengths.reduce((a, b) => a + b, 0)
  }

  /** Where the walker is after `distance`, and which way it's heading */
  at(distance: number) {
    const points = this.points
    if (points.length < 2) return { pos: points[0].clone(), dir: new THREE.Vector3() }
    let i = 0
    while (i < this.lengths.length - 1 && distance > this.lengths[i]) distance -= this.lengths[i++]
    const a = points[i],
      b = points[i + 1]
    const s = this.lengths[i] ? clamp01(distance / this.lengths[i]) : 1
    const pos = a.clone().lerp(b, s)
    pos.y = this.ground(pos.x, pos.z)
    return { pos, dir: flatDir(a, b) }
  }
}

const flatDir = (a: THREE.Vector3, b: THREE.Vector3) => new THREE.Vector3(b.x - a.x, 0, b.z - a.z).normalize()

function face(view: PieceView, dir: THREE.Vector3) {
  if (dir.lengthSq() > 1e-6) view.model.rotation.y = Math.atan2(dir.x, dir.z)
}

/** Back to standing still (keeps the way it faces) */
export function resetPose(view: PieceView) {
  const p = view.parts
  view.model.rotation.x = 0
  view.model.position.set(0, 0, 0)
  for (const leg of [...(p.frontLegs ?? []), ...(p.backLegs ?? []), ...(p.legs ?? [])]) leg.rotation.x = 0
  if (p.head) p.head.rotation.x = 0
  if (p.spear) {
    p.spear.rotation.x = 0
    p.spear.position.copy(p.spear.userData.home)
  }
  if (p.body) {
    p.body.visible = true
    p.body.scale.setScalar(1)
  }
  if (p.ball) p.ball.visible = false
}

/** Plays the motion at its current time; true once it's over */
export function playMotion(m: Motion, ground: Ground): boolean {
  const walk = m.attack ? m.points.slice(0, -1) : m.points
  m.track ??= new Track(walk, ground)
  const play = m.view.type === "sentinel" ? roll : m.view.type === "explorer" ? hop : march
  const end = play(m, walk, m.track, ground)
  if (m.fadeOut) setPieceOpacity(m.view, 1 - clamp01((m.time - (end - FADE)) / FADE))
  return m.time >= end
}

// ------------------------------------------------------------------ the victims

function hideBadges(view: PieceView) {
  view.badges.move.visible = view.badges.strength.visible = false
}

/** Flattened under the ball */
function crushed(victim: PieceView, k: number) {
  hideBadges(victim)
  const e = ease(k)
  victim.holder.scale.set(1 + 0.6 * e, Math.max(0.04, 1 - 0.95 * e), 1 + 0.6 * e)
  setPieceOpacity(victim, 1 - clamp01((k - 0.5) * 2))
}

/** Thrown up and away by the horns, spinning */
function thrown(victim: PieceView, from: THREE.Vector3, dir: THREE.Vector3, k: number) {
  hideBadges(victim)
  victim.holder.position.copy(from).addScaledVector(dir, 1.6 * k)
  victim.holder.position.y += Math.sin(Math.min(k, 1) * Math.PI) * 0.9 - k * 0.3
  victim.holder.quaternion.setFromAxisAngle(new THREE.Vector3(dir.z, 0, -dir.x), k * Math.PI * 2.5)
  setPieceOpacity(victim, 1 - clamp01((k - 0.3) / 0.7))
}

/** Falls over backwards, then fades */
function toppled(victim: PieceView, dir: THREE.Vector3, k: number) {
  hideBadges(victim)
  victim.holder.quaternion.setFromAxisAngle(new THREE.Vector3(dir.z, 0, -dir.x), (Math.PI / 2) * ease(clamp01(k * 1.6)))
  setPieceOpacity(victim, 1 - clamp01((k - 0.5) * 2))
}

// ------------------------------------------------------------------ sentinel: spin ball

const CURL = 0.22
const ROLL_SPEED = 3.6
const LEAP = 0.42
const LEAP_HEIGHT = 0.75
/** How high the ball lands on its victim, and how high it bounces back off it */
const VICTIM_TOP = 0.5
const BOUNCE = 0.4
const BOUNCE_HEIGHT = 0.55
const SQUASH = 0.22

function roll(m: Motion, walk: THREE.Vector3[], track: Track): number {
  const { view, time: t } = m
  const p = view.parts
  const rolled = CURL + track.total / ROLL_SPEED
  const landed = m.attack ? rolled + LEAP : rolled
  const bounced = m.attack ? landed + BOUNCE : rolled
  const end = bounced + CURL

  // Curl up, stay a ball the whole way, uncurl once there
  const curl = ease(t < CURL ? t / CURL : t > bounced ? 1 - (t - bounced) / CURL : 1)
  p.body!.scale.setScalar(1 - 0.75 * curl)
  p.body!.visible = curl < 0.9
  p.ball!.visible = curl > 0.05
  p.ball!.scale.setScalar(Math.max(curl, 0.01))

  const from = walk[walk.length - 1],
    target = m.points[m.points.length - 1]
  if (t < rolled) {
    const distance = Math.max(0, (t - CURL) * ROLL_SPEED)
    const { pos, dir } = track.at(distance)
    view.holder.position.copy(pos)
    face(view, dir)
    p.ballSpin!.rotation.x = distance / BALL_RADIUS
  } else if (t < landed) {
    // Leap up and onto the enemy, spinning faster
    const s = (t - rolled) / LEAP
    view.holder.position.lerpVectors(from, target, s)
    view.holder.position.y = THREE.MathUtils.lerp(from.y, target.y + VICTIM_TOP, s) + Math.sin(s * Math.PI) * LEAP_HEIGHT
    face(view, flatDir(from, target))
    p.ballSpin!.rotation.x = track.total / BALL_RADIUS + (t - rolled) * 30
  } else if (t < bounced) {
    // Crush it and bounce back down onto its square
    const s = (t - landed) / BOUNCE
    view.holder.position.copy(target)
    view.holder.position.y = THREE.MathUtils.lerp(target.y + VICTIM_TOP, target.y, s) + Math.sin(s * Math.PI) * BOUNCE_HEIGHT
    p.ballSpin!.rotation.x = track.total / BALL_RADIUS + LEAP * 30 + (t - landed) * 12
  } else view.holder.position.copy(m.attack ? target : from)

  if (m.victim && t >= landed) crushed(m.victim.view, (t - landed) / SQUASH)
  return m.victim ? Math.max(end, landed + SQUASH) : end
}

// ------------------------------------------------------------------ explorer: goat jumps

const HOP = 0.3
const LANDING = 0.12
const WINDUP = 0.32
const DASH = 0.2
/** Fraction of the dash when the horns hit */
const HIT = 0.55
const SETTLE = 0.3
const FLY = 0.7

function hop(m: Motion, walk: THREE.Vector3[]): number {
  const { view, time: t } = m
  const p = view.parts
  const hopsDone = (walk.length - 1) * HOP
  const legs = (front: number, back: number) => {
    for (const leg of p.frontLegs!) leg.rotation.x = front
    for (const leg of p.backLegs!) leg.rotation.x = back
  }
  if (!m.attack) {
    if (t < hopsDone) jump(view, walk, t, legs)
    else {
      view.holder.position.copy(walk[walk.length - 1])
      // A little crouch as it lands
      view.model.rotation.x = 0
      legs(0, 0)
      view.model.position.y = -Math.sin(clamp01((t - hopsDone) / LANDING) * Math.PI) * 0.04
    }
    return hopsDone + LANDING
  }

  const from = walk[walk.length - 1],
    target = m.points[m.points.length - 1]
  const dir = flatDir(from, target)
  const charged = hopsDone + WINDUP
  const dashed = charged + DASH
  const hit = charged + DASH * HIT
  if (t < hopsDone) jump(view, walk, t, legs)
  else if (t < charged) {
    // Steps back, lowers its horns and paws the ground
    const w = (t - hopsDone) / WINDUP
    face(view, dir)
    view.model.rotation.x = 0
    view.holder.position.copy(from).addScaledVector(dir, -0.1 * ease(w))
    p.head!.rotation.x = 0.75 * ease(w)
    legs(-0.5 * Math.abs(Math.sin(w * Math.PI * 3)), 0.2 * ease(w))
  } else if (t < dashed) {
    // Charges, faster and faster
    const s = (t - charged) / DASH
    view.holder.position.copy(from).addScaledVector(dir, -0.1).lerp(target, s * s)
    view.holder.position.y = THREE.MathUtils.lerp(from.y, target.y, s)
    view.model.rotation.x = 0.15
    p.head!.rotation.x = 0.75
    const gallop = Math.sin(s * Math.PI * 4) * 0.7
    legs(gallop, -gallop)
  } else {
    // Head back up on the freed square
    const s = clamp01((t - dashed) / SETTLE)
    view.holder.position.copy(target)
    view.model.rotation.x = 0.15 * (1 - s)
    p.head!.rotation.x = 0.75 * (1 - ease(s))
    legs(0, 0)
  }
  if (m.victim && t >= hit) thrown(m.victim.view, target, dir, (t - hit) / FLY)
  return Math.max(dashed + SETTLE, m.victim ? hit + FLY : 0)
}

/** One jump per square: nose up on take-off, down on landing, legs stretched out in the air */
function jump(view: PieceView, walk: THREE.Vector3[], t: number, legs: (front: number, back: number) => void) {
  const i = Math.min(Math.floor(t / HOP), walk.length - 2)
  const s = t / HOP - i
  const a = walk[i],
    b = walk[i + 1]
  view.holder.position.lerpVectors(a, b, s)
  view.holder.position.y += Math.sin(s * Math.PI) * (0.32 + Math.abs(b.y - a.y) * 0.6)
  face(view, flatDir(a, b))
  view.model.rotation.x = -0.35 * Math.cos(s * Math.PI)
  const stretch = Math.sin(s * Math.PI)
  legs(-0.9 * stretch, 0.9 * stretch)
}

// ------------------------------------------------------------------ vanguard: march and spear thrust

const WALK_SPEED = 2.4
const STRIDE = 0.45
const AIM = 0.25
const THRUST = 0.12
const HOLD = 0.15
const STEP_IN = 0.4
const FALL = 0.6
/** How far the spear turns down to point at the enemy, and how far the soldier lunges */
const SPEAR_DOWN = 0.95
const LUNGE = 0.25

function march(m: Motion, walk: THREE.Vector3[], track: Track, ground: Ground): number {
  const { view, time: t } = m
  const p = view.parts
  const spear = p.spear!
  const home: THREE.Vector3 = spear.userData.home
  const stride = (distance: number) => {
    const phase = (distance / STRIDE) * Math.PI
    p.legs![0].rotation.x = Math.sin(phase) * 0.55
    p.legs![1].rotation.x = -Math.sin(phase) * 0.55
    view.model.position.y = Math.abs(Math.sin(phase)) * 0.03
  }
  const walked = track.total / WALK_SPEED
  if (t < walked || !m.attack) {
    const distance = Math.min(t * WALK_SPEED, track.total)
    const { pos, dir } = track.at(distance)
    view.holder.position.copy(pos)
    face(view, dir)
    stride(t < walked ? distance : 0)
    return walked
  }

  const from = walk[walk.length - 1],
    target = m.points[m.points.length - 1]
  const dir = flatDir(from, target)
  const aimed = walked + AIM
  const hit = aimed + THRUST
  const held = hit + HOLD
  const end = held + STEP_IN
  face(view, dir)
  stride(0)
  const lunge = from.clone().addScaledVector(dir, LUNGE)
  if (t < aimed) {
    // Lowers the spear at the enemy and draws it back
    const w = ease((t - walked) / AIM)
    spear.rotation.x = SPEAR_DOWN * w
    spear.position.set(home.x, home.y, home.z - 0.08 * w)
    view.model.rotation.x = -0.12 * w
    view.holder.position.copy(from)
  } else if (t < held) {
    // Lunges and thrusts
    const s = clamp01((t - aimed) / THRUST)
    spear.rotation.x = SPEAR_DOWN
    spear.position.set(home.x, home.y, home.z - 0.08 + 0.32 * s)
    view.model.rotation.x = -0.12 + 0.35 * s
    view.holder.position.lerpVectors(from, lunge, s)
  } else {
    // Pulls the spear back up and steps onto the freed square
    const s = clamp01((t - held) / STEP_IN)
    spear.rotation.x = SPEAR_DOWN * (1 - ease(s))
    spear.position.set(home.x, home.y, home.z + 0.24 * (1 - ease(s)))
    view.model.rotation.x = 0.23 * (1 - ease(s))
    view.holder.position.lerpVectors(lunge, target, ease(s))
    view.holder.position.y = ground(view.holder.position.x, view.holder.position.z)
    stride(s * LUNGE * 4)
  }
  if (m.victim && t >= hit) toppled(m.victim.view, dir, (t - hit) / FALL)
  return Math.max(end, m.victim ? hit + FALL : 0)
}
