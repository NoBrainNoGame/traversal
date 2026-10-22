import * as THREE from "three"
import { cellAt, cellX, cellY, goalRow, inBoard, N, type GameState, type LegalAction, type Seat } from "../shared/rules"
import { makePiece, type PieceView } from "./characters"
import { playMotion, resetPose, type Motion } from "./motion"
import { HAZE, Landscape } from "./landscape"
import { BASE, boardHeight, boardWeights, heightColor, Scenery, STEP } from "./scenery"
import { sceneUniforms } from "./shading"

/** Mesh resolution of the board ground, in vertices per square */
const CELL_DIVISIONS = 16
/** Squares painted over the ground: finer than the ground mesh so they hug its slopes, and pulled toward the camera in depth */
const DRAPE_DIVISIONS = 24
const DRAPE_LIFT = 0.035
const OVERLAY = { transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }
/** A press is a click only if the pointer moved less than this between down and up (else it's a board drag) */
const CLICK_TOLERANCE_PX = 6
const TILT_RANGE = [-0.55, 0.4]
const ZOOM_RANGE = [9, 30]
const DEFAULT_DISTANCE = 17.5
const UP = new THREE.Vector3(0, 1, 0)
/** Following an opponent's move: how close the camera gets, how long it waits on the piece before going back */
const FOLLOW_DISTANCE = 10
const FOLLOW_HOLD = 0.7
/** The follow view looks at the piece three-quarters on: halfway between its side (the lower ground, so nothing hides it) and its front, from 30° up */
const FOLLOW_AHEAD = THREE.MathUtils.degToRad(45)
const FOLLOW_ELEVATION = THREE.MathUtils.degToRad(30)
/** The camera aims a little above the ground (see applyView's lookAt): this puts the piece's body in the middle */
const FOLLOW_LOOK_DROP = 0.2
/** Seconds to close in on the piece, and to go back to the player's view */
const FOLLOW_IN = 0.6
const FOLLOW_OUT = 1
/** How fast the shown view catches up with the wanted one (per second): every camera move is eased */
const VIEW_DAMPING = 10
const LAST_MOVE_COLOR = "255,165,58"
/** Angle at which the camera looks down at the untilted board */
const VIEW_ELEVATION = Math.atan2(0.69, 0.72)
/** Where the stat badges sit around a piece's feet, in screen-aligned directions */
const BADGE_SIDE = 0.25
const BADGE_FRONT = 0.22

/** One square of a piece's reach: what it costs to walk there, or how an attack there would go */
export interface ScopeMark {
  cell: number
  kind: "move" | "attack"
  label: string
  /** An attack that would fail */
  muted?: boolean
}

export type Pick = { kind: "piece"; pieceId: number } | { kind: "cell"; cell: number } | { kind: "exit"; cell: number } | { kind: "none" }

/** The camera closing in on a piece the opponent moves; `weight` blends from the player's own view (0) to the piece (1) */
interface Follow {
  pieceId: number
  target: THREE.Vector3
  /** Board turn that puts the camera beside the piece */
  yaw: number
  weight: number
  hold: number
}

export class Board3D extends EventTarget {
  readonly renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  /**
   * The camera and the lights never move: dragging tilts `pivot`, slides `pan` within the tilted board plane
   * and spins `world` (the board and its pieces).
   * yaw, tilt, distance and userPan are the view the player chose; following an opponent's move only blends
   * another view on top of it, so the camera always comes back to where the player left it
   */
  private pivot = new THREE.Group()
  private pan = new THREE.Group()
  private world = new THREE.Group()
  private yaw = 0
  private tilt = 0
  private distance = DEFAULT_DISTANCE
  private userPan = new THREE.Vector3()
  /** What is on screen: eases toward the wanted view every frame */
  private shown = { yaw: 0, tilt: 0, distance: DEFAULT_DISTANCE, center: new THREE.Vector3() }
  /** The shown view has reached the followed piece */
  private focused = false
  private follow: Follow | null = null
  /** Which side this client plays (null: spectator), to tell the opponent's moves apart */
  private viewer: Seat | null = null
  private state: GameState | null = null
  private lastMove = new THREE.Group()
  private lastMoveTextures = new Map<boolean, THREE.CanvasTexture>()
  private camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2000)
  private raycaster = new THREE.Raycaster()
  private terrain = new THREE.Group()
  private scenery = new Scenery()
  private landscape = new Landscape()
  private highlights = new THREE.Group()
  private scope = new THREE.Group()
  /** Ground labels by look; their text is turned every frame to face the viewer */
  private scopeTextures = new Map<string, THREE.CanvasTexture>()
  private ground: THREE.Mesh | null = null
  private pieces = new Map<number, PieceView>()
  private exitMarkers: THREE.Mesh[] = []
  private anims = new Map<number, Motion>()
  /** Pieces being killed: kept on the board until their killer's motion is done with them */
  private dying = new Set<number>()
  private heights: number[] = []
  private selection = new THREE.Mesh(
    new THREE.RingGeometry(0.36, 0.46, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xffe066, transparent: true, opacity: 0.95, depthTest: false }),
  )
  private hoverMesh = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial({ color: 0xffffff, opacity: 0.35, ...OVERLAY }),
  )
  private pathLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffe066, depthTest: false }))
  private down: { x: number; y: number; lastX: number; lastY: number; button: number; dragging: boolean } | null = null
  private lastTime = performance.now()
  private seatView: Seat | null = null

  constructor(
    private canvas: HTMLCanvasElement,
    eventTarget: HTMLElement,
    private isOverUi: (x: number, y: number) => boolean,
  ) {
    super()
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    this.renderer.shadowMap.enabled = true
    // No fog: the land fades out toward its edge (see shading.ts), over the sky and the far landscape
    this.scene.background = HAZE

    this.scene.add(new THREE.HemisphereLight(0xe6ecff, 0x3a3020, 1.6))
    const sun = new THREE.DirectionalLight(0xfff1e0, 2.2)
    sun.position.set(-5, 12, 8)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    Object.assign(sun.shadow.camera, { left: -11, right: 11, top: 11, bottom: -11 })
    this.scene.add(sun)

    this.pivot.add(this.pan)
    this.pan.add(this.world)
    this.scene.add(this.pivot)
    this.world.add(this.landscape.group, this.terrain, this.scenery.group, this.scope, this.highlights)
    this.selection.renderOrder = 10
    this.selection.visible = false
    this.hoverMesh.visible = false
    this.pathLine.renderOrder = 11
    this.world.add(this.selection, this.hoverMesh, this.pathLine, this.lastMove)
    this.applyView(1)

    // Capture on the parent so a press that starts on the UI is never treated as a board drag
    eventTarget.parentElement!.addEventListener(
      "pointerdown",
      (e) => {
        if (this.isOverUi(e.clientX, e.clientY)) return
        this.down = { x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY, button: e.button, dragging: false }
        try {
          eventTarget.setPointerCapture(e.pointerId)
        } catch {}
      },
      { capture: true },
    )
    eventTarget.addEventListener("pointermove", (e) => {
      const down = this.down
      if (down) {
        if (!down.dragging && Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_TOLERANCE_PX) down.dragging = true
        if (down.dragging) this.drag(down.button, e.clientX - down.lastX, e.clientY - down.lastY)
        down.lastX = e.clientX
        down.lastY = e.clientY
        // While dragging the board, don't flicker hover previews
        return
      }
      const pick: Pick = this.isOverUi(e.clientX, e.clientY) ? { kind: "none" } : this.pickAt(e.clientX, e.clientY)
      this.dispatchEvent(new CustomEvent<Pick>("hover", { detail: pick }))
    })
    eventTarget.addEventListener("pointerup", (e) => {
      const down = this.down
      this.down = null
      if (!down || down.dragging || down.button !== 0) return
      this.dispatchEvent(new CustomEvent<Pick>("pick", { detail: this.pickAt(e.clientX, e.clientY) }))
    })
    eventTarget.addEventListener("pointercancel", () => (this.down = null))
    eventTarget.addEventListener("pointerleave", () => this.dispatchEvent(new CustomEvent<Pick>("hover", { detail: { kind: "none" } })))
    eventTarget.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault()
        if (this.isOverUi(e.clientX, e.clientY)) return
        this.takeOver()
        this.distance = THREE.MathUtils.clamp(this.distance * Math.exp(e.deltaY * 0.001), ZOOM_RANGE[0], ZOOM_RANGE[1])
      },
      { passive: false },
    )
  }

  /** Right drag spins and tilts the board, left drag slides it */
  private drag(button: number, dx: number, dy: number) {
    this.takeOver()
    if (button === 2) {
      this.yaw += dx * 0.008
      this.tilt = THREE.MathUtils.clamp(this.tilt + dy * 0.004, TILT_RANGE[0], TILT_RANGE[1])
    } else if (button === 0) {
      const scale = this.distance / 900
      // Slide within the board plane so the camera keeps its height above the ground (the wheel handles that).
      // The ground is seen at a slant, so depth moves are stretched to follow the pointer
      const slant = Math.sin(VIEW_ELEVATION + this.tilt)
      this.userPan.x += dx * scale
      this.userPan.z += (dy * scale) / slant
    }
  }

  /** The view wanted right now: the player's own, blended toward the followed piece */
  /** The view wanted right now: the player's own, blended toward the followed piece. `center` is the board point in the middle of the screen */
  private wantedView() {
    let { distance, yaw, tilt } = this
    const center = this.userPan.clone().negate().applyAxisAngle(UP, -this.yaw)
    const weight = this.follow ? THREE.MathUtils.smootherstep(this.follow.weight, 0, 1) : 0
    if (weight > 0) {
      // Turn the board to see the piece three-quarters on, lower the camera, zoom in, piece in the middle
      yaw = THREE.MathUtils.lerp(yaw, this.follow!.yaw, weight)
      tilt = THREE.MathUtils.lerp(tilt, FOLLOW_ELEVATION - VIEW_ELEVATION, weight)
      // Its height counts too: from low down, a piece up on a hill would otherwise sit high on the screen
      center.lerp(this.follow!.target.clone().setY(this.follow!.target.y - FOLLOW_LOOK_DROP), weight)
      distance = THREE.MathUtils.lerp(distance, Math.min(distance, FOLLOW_DISTANCE), weight)
    }
    return { yaw, tilt, distance, center }
  }

  /** The slide that puts a board point in the middle of the screen, the board being turned by `yaw` */
  private panFor(center: THREE.Vector3, yaw: number) {
    return center.clone().applyAxisAngle(UP, yaw).negate()
  }

  /**
   * The board turn that shows a move three-quarters on: from the side of its path where the ground is lower,
   * turned halfway toward where the piece is heading
   */
  private sideYaw(path: number[]) {
    const points = path.map((c) => this.cellTop(c))
    const from = points[0],
      to = points[points.length - 1]
    const dir = new THREE.Vector3(to.x - from.x, 0, to.z - from.z)
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1)
    dir.normalize()
    const left = new THREE.Vector3(dir.z, 0, -dir.x)
    const groundBeside = (side: THREE.Vector3) => points.reduce((sum, p) => sum + boardHeight(this.heights, p.x + side.x, p.z + side.z), 0)
    const side = groundBeside(left) <= groundBeside(left.clone().negate()) ? left : left.negate()
    const camera = side.multiplyScalar(Math.cos(FOLLOW_AHEAD)).addScaledVector(dir, Math.sin(FOLLOW_AHEAD))
    // The board turn that brings this direction toward the camera, the short way round from the player's view
    const yaw = Math.atan2(-camera.x, camera.z)
    return this.yaw + THREE.MathUtils.euclideanModulo(yaw - this.yaw + Math.PI, Math.PI * 2) - Math.PI
  }

  /** Eases the shown view toward the wanted one; `ease` 1 jumps straight there */
  private applyView(ease: number) {
    const wanted = this.wantedView()
    const shown = this.shown
    shown.yaw += (wanted.yaw - shown.yaw) * ease
    shown.tilt += (wanted.tilt - shown.tilt) * ease
    shown.distance += (wanted.distance - shown.distance) * ease
    // Easing the screen's centre point (not the slide) keeps the piece in the middle while the board turns
    shown.center.lerp(wanted.center, ease)
    this.focused =
      !!this.follow &&
      this.follow.weight >= 1 &&
      shown.center.distanceTo(wanted.center) < 0.05 &&
      Math.abs(wanted.distance - shown.distance) < 0.05 &&
      Math.abs(wanted.yaw - shown.yaw) < 0.02 &&
      Math.abs(wanted.tilt - shown.tilt) < 0.02
    this.world.rotation.y = shown.yaw
    this.pivot.rotation.x = shown.tilt
    this.pan.position.copy(this.panFor(shown.center, shown.yaw))
    this.camera.position.set(0, shown.distance * 0.69, shown.distance * 0.72)
    this.camera.lookAt(0, 0.5, 0)
  }

  /** The player moves the camera during a follow: keep the followed view as their own and stop following */
  private takeOver() {
    if (!this.follow) return
    const wanted = this.wantedView()
    this.userPan.copy(this.panFor(wanted.center, wanted.yaw))
    this.distance = wanted.distance
    this.yaw = wanted.yaw
    this.tilt = wanted.tilt
    this.follow = null
  }

  /** Turns the board so the given player's starting row faces the camera */
  setSeatView(seat: Seat) {
    if (this.seatView === seat) return
    this.seatView = seat
    this.resetView()
  }

  /** Back to the starting view: the player's side facing the camera, not panned, tilted or zoomed */
  resetView() {
    this.follow = null
    this.yaw = this.seatView === 0 ? Math.PI : 0
    this.tilt = 0
    this.distance = DEFAULT_DISTANCE
    this.userPan.set(0, 0, 0)
  }

  /** Which side this client plays: the camera follows and the board marks the other side's moves */
  setViewer(seat: Seat | null) {
    this.viewer = seat
    if (this.state) this.showLastMove(this.state)
  }

  resize(width: number, height: number) {
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
  }

  cellTop(cell: number, lift = 0) {
    return new THREE.Vector3(cellX(cell) - N / 2 + 0.5, BASE + this.heights[cell] * STEP + lift, cellY(cell) - N / 2 + 0.5)
  }

  /** One continuous ground for the whole board: flat square tops joined by slopes, with a faint line between squares */
  private buildTerrain(heights: number[]) {
    this.heights = heights
    this.terrain.clear()
    const colors = Array.from({ length: N * N }, (_, c) => {
      const color = heightColor(heights[c])
      if ((cellX(c) + cellY(c)) % 2) color.offsetHSL(0, 0, -0.03)
      return color
    })
    const segments = N * CELL_DIVISIONS
    const geo = new THREE.PlaneGeometry(N, N, segments, segments).rotateX(-Math.PI / 2)
    const pos = geo.attributes.position
    const vertexColors = new Float32Array(pos.count * 3)
    const color = new THREE.Color()
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i),
        z = pos.getZ(i)
      color.setRGB(0, 0, 0)
      let y = 0
      for (const { cell, w } of boardWeights(x, z)) {
        y += (BASE + heights[cell] * STEP) * w
        color.r += colors[cell].r * w
        color.g += colors[cell].g * w
        color.b += colors[cell].b * w
      }
      pos.setY(i, y)
      const u = x + N / 2,
        v = z + N / 2
      const toEdge = Math.min(Math.abs(u - Math.round(u)), Math.abs(v - Math.round(v)))
      color.multiplyScalar(1 - 0.16 * (1 - THREE.MathUtils.smoothstep(toEdge, 0, 0.06)))
      color.toArray(vertexColors, i * 3)
    }
    geo.setAttribute("color", new THREE.BufferAttribute(vertexColors, 3))
    geo.computeVertexNormals()
    const material = this.scenery.boardMaterial()
    this.ground = new THREE.Mesh(geo, material)
    this.ground.castShadow = this.ground.receiveShadow = true
    this.ground.userData.board = true
    this.terrain.add(this.ground, this.buildSkirt(heights))
    this.scenery.build(heights)
  }

  /** Earth wall around the board's rim, so no crack shows where it meets the landscape */
  private buildSkirt(heights: number[]) {
    const positions: number[] = []
    const half = N / 2
    const corners = [
      [-half, -half],
      [half, -half],
      [half, half],
      [-half, half],
      [-half, -half],
    ]
    for (let k = 0; k < 4; k++) {
      const [x0, z0] = corners[k],
        [x1, z1] = corners[k + 1]
      const steps = N * CELL_DIVISIONS
      for (let s = 0; s < steps; s++) {
        const a = s / steps,
          b = (s + 1) / steps
        const xa = x0 + (x1 - x0) * a,
          za = z0 + (z1 - z0) * a
        const xb = x0 + (x1 - x0) * b,
          zb = z0 + (z1 - z0) * b
        const ya = boardHeight(heights, xa, za),
          yb = boardHeight(heights, xb, zb)
        positions.push(xa, ya, za, xa, 0, za, xb, yb, zb, xb, yb, zb, xa, 0, za, xb, 0, zb)
      }
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3))
    geo.computeVertexNormals()
    return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x4a3c30, roughness: 1, side: THREE.DoubleSide }))
  }

  /** A highlight laid over the ground of a square, following its slopes */
  private drape(cell: number, size: number, lift: number) {
    const center = this.cellTop(cell)
    const geo = new THREE.PlaneGeometry(size, size, DRAPE_DIVISIONS, DRAPE_DIVISIONS).rotateX(-Math.PI / 2).translate(center.x, 0, center.z)
    const pos = geo.attributes.position
    for (let i = 0; i < pos.count; i++) pos.setY(i, boardHeight(this.heights, pos.getX(i), pos.getZ(i)) + lift)
    return geo
  }

  /** Syncs the scene with a new game state; animates the last action if it's new (and follows it if it's the opponent's) */
  setState(state: GameState, animate: boolean) {
    this.state = state
    if (state.heights.join() !== this.heights.join()) {
      this.buildTerrain(state.heights)
      for (const view of this.pieces.values()) this.world.remove(view.holder)
      this.pieces.clear()
      this.anims.clear()
      this.dying.clear()
      animate = false
    }
    const last = state.last
    const followed = animate && last && this.isOpponents(state, last.action.pieceId) ? last.action.pieceId : null
    if (followed !== null) {
      const view = this.pieces.get(followed)
      // Moves in a row keep the camera where it already is
      this.follow = {
        pieceId: followed,
        target: view ? view.holder.position.clone() : new THREE.Vector3(),
        yaw: this.sideYaw(last!.path),
        weight: this.follow?.weight ?? 0,
        hold: FOLLOW_HOLD,
      }
    }
    const waitForCamera = followed !== null
    // Kept until the attacker is done with it, wherever it comes in the loop below
    const victim = animate && last?.captured != null ? last.captured : null
    if (victim !== null && this.pieces.has(victim)) this.dying.add(victim)

    for (const piece of state.pieces) {
      let view = this.pieces.get(piece.id)
      if (!view) {
        if (piece.status !== "board") continue
        view = makePiece(piece.type, piece.owner, piece.id)
        view.holder.position.copy(this.cellTop(piece.cell))
        this.world.add(view.holder)
        this.pieces.set(piece.id, view)
      }
      const mesh = view.holder
      if (animate && last && last.action.pieceId === piece.id) {
        const points = last.path.map((c) => this.cellTop(c))
        if (last.action.kind === "exit") {
          const off = points[points.length - 1].clone()
          off.z += piece.owner === 0 ? 1.2 : -1.2
          points.push(off)
        }
        this.finishMotion(piece.id)
        const victimView = victim !== null ? this.pieces.get(victim) : undefined
        this.anims.set(piece.id, {
          view,
          points,
          attack: last.action.kind === "attack",
          victim: victimView ? { id: victim!, view: victimView } : null,
          fadeOut: piece.status === "finished",
          waitForCamera,
          time: 0,
          onCue: (cue) => this.dispatchEvent(new CustomEvent("cue", { detail: cue })),
        })
      } else if (piece.status === "board") {
        if (!this.anims.has(piece.id)) mesh.position.copy(this.cellTop(piece.cell))
      } else if (!this.anims.has(piece.id) && !this.dying.has(piece.id)) {
        this.world.remove(mesh)
        this.pieces.delete(piece.id)
      }
    }
    this.showLastMove(state)
  }

  /** Ends a piece's motion where it stands: back to rest, the dead and the departed removed */
  private finishMotion(id: number) {
    const motion = this.anims.get(id)
    if (!motion) return
    this.anims.delete(id)
    resetPose(motion.view)
    if (motion.fadeOut) this.removePiece(id)
    if (motion.victim) {
      this.dying.delete(motion.victim.id)
      this.removePiece(motion.victim.id)
    }
  }

  private removePiece(id: number) {
    const view = this.pieces.get(id)
    if (view) this.world.remove(view.holder)
    this.pieces.delete(id)
  }

  private isOpponents(state: GameState, pieceId: number) {
    return state.pieces[pieceId].owner !== this.viewer
  }

  /** Marks the opponent's last move: the square it left, and a frame around where the piece now stands */
  private showLastMove(state: GameState) {
    this.lastMove.clear()
    const last = state.last
    if (!last || !this.isOpponents(state, last.action.pieceId)) return
    const tile = (cell: number, filled: boolean) =>
      new THREE.Mesh(this.drape(cell, 0.96, DRAPE_LIFT - 0.01), new THREE.MeshBasicMaterial({ map: this.lastMoveTexture(filled), ...OVERLAY }))
    this.lastMove.add(tile(last.path[0], true))
    const piece = state.pieces[last.action.pieceId]
    if (piece.status === "board") {
      const frame = tile(piece.cell, false)
      // Shown once the piece gets there
      frame.userData.waitFor = piece.id
      frame.visible = !this.anims.has(piece.id)
      this.lastMove.add(frame)
    }
  }

  private lastMoveTexture(filled: boolean) {
    let texture = this.lastMoveTextures.get(filled)
    if (texture) return texture
    const size = 128
    const canvas = document.createElement("canvas")
    canvas.width = canvas.height = size
    const ctx = canvas.getContext("2d")!
    if (filled) {
      ctx.fillStyle = `rgba(${LAST_MOVE_COLOR},0.3)`
      ctx.fillRect(0, 0, size, size)
    }
    ctx.strokeStyle = `rgba(${LAST_MOVE_COLOR},0.9)`
    ctx.lineWidth = 9
    ctx.beginPath()
    ctx.roundRect(8, 8, size - 16, size - 16, 14)
    ctx.stroke()
    texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy()
    this.lastMoveTextures.set(filled, texture)
    return texture
  }

  /** Shows the selected piece's options: green moves, red attacks, gold exits */
  showActions(pieceCell: number | null, actions: LegalAction[]) {
    this.highlights.clear()
    this.exitMarkers = []
    this.selection.visible = pieceCell !== null
    if (pieceCell !== null) this.selection.position.copy(this.cellTop(pieceCell, 0.02))
    for (const la of actions) {
      const a = la.action
      if (a.kind === "exit") {
        const marker = new THREE.Mesh(
          new THREE.ConeGeometry(0.22, 0.5, 4).rotateX(cellY(a.from) === N - 1 ? Math.PI / 2 : -Math.PI / 2),
          new THREE.MeshBasicMaterial({ color: 0xffc23a }),
        )
        const top = this.cellTop(a.from, 0.2)
        top.z += goalRow(0) === cellY(a.from) ? 0.75 : -0.75
        marker.position.copy(top)
        marker.userData.exitCell = a.from
        this.highlights.add(marker)
        this.exitMarkers.push(marker)
        continue
      }
      const color = a.kind === "attack" ? 0xff4d4d : a.special ? 0x6ad8ff : 0x5ee07a
      const tile = new THREE.Mesh(
        this.drape(a.to, 0.8, DRAPE_LIFT),
        new THREE.MeshBasicMaterial({ color, opacity: a.kind === "attack" ? 0.7 : 0.5, ...OVERLAY }),
      )
      this.highlights.add(tile)
    }
  }

  /**
   * Shows a piece's reach, painted on the ground: a translucent white square (red on enemies, grey for a lost attack)
   * with the walking cost or the attack modifier written on it. Without `tint`, only the numbers are painted
   * (the move highlights already colour the squares).
   */
  showScope(marks: ScopeMark[], tint = true) {
    this.scope.clear()
    for (const mark of marks) {
      const background = !tint ? null : mark.kind === "move" ? "255,255,255" : mark.muted ? "138,133,128" : "255,77,77"
      // On an enemy's square the number sits at the front edge, clear of the piece standing in the middle
      const front = mark.kind === "attack"
      const tile = new THREE.Mesh(
        this.drape(mark.cell, 0.84, front ? DRAPE_LIFT + 0.02 : DRAPE_LIFT),
        new THREE.MeshBasicMaterial({ map: this.scopeTexture(mark.label, background, front), ...OVERLAY }),
      )
      this.scope.add(tile)
    }
  }

  private scopeTexture(text: string, background: string | null, front: boolean) {
    const key = `${text}|${background}|${front}`
    let texture = this.scopeTextures.get(key)
    if (texture) return texture
    const size = 128
    const canvas = document.createElement("canvas")
    canvas.width = canvas.height = size
    const ctx = canvas.getContext("2d")!
    if (background) {
      ctx.fillStyle = `rgba(${background},0.33)`
      ctx.fillRect(0, 0, size, size)
    }
    ctx.font = `bold ${front ? 40 : 76}px sans-serif`
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    const y = front ? 106 : 68
    // Cut the digits out of the background first, so they get exactly their own opacity
    ctx.globalCompositeOperation = "destination-out"
    ctx.fillText(text, size / 2, y)
    ctx.globalCompositeOperation = "source-over"
    ctx.fillStyle = "rgba(255,255,255,0.66)"
    ctx.fillText(text, size / 2, y)
    texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.center.set(0.5, 0.5)
    texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy()
    this.scopeTextures.set(key, texture)
    return texture
  }

  /** Highlights the hovered square and the path the piece would take */
  showHover(cell: number | null, path: number[] = []) {
    this.hoverMesh.visible = cell !== null
    if (cell !== null) {
      this.hoverMesh.geometry.dispose()
      this.hoverMesh.geometry = this.drape(cell, 0.96, DRAPE_LIFT + 0.005)
    }
    this.pathLine.geometry.dispose()
    this.pathLine.geometry = new THREE.BufferGeometry().setFromPoints(path.map((c) => this.cellTop(c, 0.12)))
  }

  private pickAt(clientX: number, clientY: number): Pick {
    const rect = this.canvas.getBoundingClientRect()
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
    this.raycaster.setFromCamera(ndc, this.camera)
    const holders = [...this.pieces.values()].map((view) => view.holder)
    const targets = [...this.exitMarkers, ...holders, ...(this.ground ? [this.ground] : [])]
    const hit = this.raycaster.intersectObjects(targets, true)[0]
    if (!hit) return { kind: "none" }
    // A piece is a group of parts: climb up to the part that carries the id
    let owner: THREE.Object3D | null = hit.object
    while (owner.parent && owner.userData.pieceId === undefined) owner = owner.parent
    const data = owner.userData.pieceId !== undefined ? owner.userData : hit.object.userData
    if (data.exitCell !== undefined) return { kind: "exit", cell: data.exitCell }
    if (data.pieceId !== undefined) return { kind: "piece", pieceId: data.pieceId }
    if (data.board) {
      const local = this.world.worldToLocal(hit.point.clone())
      const x = Math.floor(local.x + N / 2),
        y = Math.floor(local.z + N / 2)
      if (inBoard(x, y)) return { kind: "cell", cell: cellAt(x, y) }
    }
    return { kind: "none" }
  }

  render() {
    const now = performance.now()
    const dt = Math.min((now - this.lastTime) / 1000, 0.1)
    this.lastTime = now

    const ground = (x: number, z: number) => boardHeight(this.heights, x, z)
    for (const [id, motion] of this.anims) {
      if (motion.waitForCamera) {
        if (this.follow && !this.focused) continue
        motion.waitForCamera = false
      }
      motion.time += dt
      if (playMotion(motion, ground)) this.finishMotion(id)
    }

    for (const tile of this.lastMove.children) if (tile.userData.waitFor !== undefined) tile.visible = !this.anims.has(tile.userData.waitFor)
    if (this.follow) this.updateFollow(dt)
    this.applyView(1 - Math.exp(-dt * VIEW_DAMPING))

    // Badges stay at the screen-left (movement) and screen-right (strength) of each piece's feet, whatever the board's rotation
    this.world.updateMatrixWorld()
    const toLocal = this.world.getWorldQuaternion(new THREE.Quaternion()).invert()
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion).applyQuaternion(toLocal).setY(0).normalize()
    const front = new THREE.Vector3(0, 0, 1).applyQuaternion(this.camera.quaternion).applyQuaternion(toLocal).setY(0).normalize()
    const seconds = now / 1000
    // Ground numbers turn in 45° steps so they always read upright from where the board is seen
    const textAngle = Math.round(Math.atan2(front.x, front.z) / (Math.PI / 4)) * (Math.PI / 4)
    for (const texture of this.scopeTextures.values()) texture.rotation = textAngle
    for (const [id, view] of this.pieces) {
      view.badges.move.position.copy(right).multiplyScalar(-BADGE_SIDE).addScaledVector(front, BADGE_FRONT).setY(0.08)
      view.badges.strength.position.copy(right).multiplyScalar(BADGE_SIDE).addScaledVector(front, BADGE_FRONT).setY(0.08)
      view.model.userData.animate?.(seconds + id)
    }

    this.selection.material.opacity = 0.7 + Math.sin(now / 200) * 0.25
    sceneUniforms.uEdgeInverse.value.copy(this.world.matrixWorld).invert()
    this.scenery.update(seconds, dt)
    this.landscape.update(seconds)
    this.renderer.render(this.scene, this.camera)
  }

  /** Pieces are moving or the camera is following one */
  get busy() {
    return this.anims.size > 0 || !!this.follow
  }

  /** Closes in while the piece moves, lingers a moment, then eases back to the player's view */
  private updateFollow(dt: number) {
    const follow = this.follow!
    const view = this.pieces.get(follow.pieceId)
    if (view) follow.target.copy(view.holder.position)
    if (this.anims.has(follow.pieceId) || follow.hold > 0) {
      follow.weight = Math.min(1, follow.weight + dt / FOLLOW_IN)
      if (!this.anims.has(follow.pieceId)) follow.hold -= dt
    } else {
      follow.weight -= dt / FOLLOW_OUT
      if (follow.weight <= 0) this.follow = null
    }
  }
}
