import * as THREE from "three"
import { cellAt, cellX, cellY, goalRow, inBoard, N, type GameState, type LegalAction, type Seat } from "../shared/rules"
import { makePiece, setPieceOpacity, type PieceView } from "./characters"
import { BASE, boardHeight, boardWeights, heightColor, Scenery, STEP } from "./scenery"

const FOG_COLOR = 0x1d232b
/** Mesh resolution of the board ground, in vertices per square */
const CELL_DIVISIONS = 16
/** Squares painted over the ground: finer than the ground mesh so they hug its slopes, and pulled toward the camera in depth */
const DRAPE_DIVISIONS = 24
const DRAPE_LIFT = 0.035
const OVERLAY = { transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }
/** A press is a click only if the pointer moved less than this between down and up (else it's a board drag) */
const CLICK_TOLERANCE_PX = 6
const TILT_RANGE = [-0.45, 0.4]
const ZOOM_RANGE = [9, 30]
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

interface PieceAnim {
  points: THREE.Vector3[]
  t: number
  fadeOut: boolean
}

export class Board3D extends EventTarget {
  readonly renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  /**
   * The camera and the lights never move: dragging tilts `pivot`, slides `pan` within the tilted board plane
   * and spins `world` (the board and its pieces)
   */
  private pivot = new THREE.Group()
  private pan = new THREE.Group()
  private world = new THREE.Group()
  private yaw = 0
  private tilt = 0
  private distance = 17.5
  private camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100)
  private raycaster = new THREE.Raycaster()
  private terrain = new THREE.Group()
  private scenery = new Scenery()
  private highlights = new THREE.Group()
  private scope = new THREE.Group()
  /** Ground labels by look; their text is turned every frame to face the viewer */
  private scopeTextures = new Map<string, THREE.CanvasTexture>()
  private ground: THREE.Mesh | null = null
  private pieces = new Map<number, PieceView>()
  private exitMarkers: THREE.Mesh[] = []
  private anims = new Map<number, PieceAnim>()
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
    this.scene.background = new THREE.Color(FOG_COLOR)
    this.scene.fog = new THREE.Fog(FOG_COLOR, 20, 40)

    this.scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x3a3020, 1.6))
    const sun = new THREE.DirectionalLight(0xffffff, 2.2)
    sun.position.set(-5, 12, 8)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    Object.assign(sun.shadow.camera, { left: -11, right: 11, top: 11, bottom: -11 })
    this.scene.add(sun)

    this.pivot.add(this.pan)
    this.pan.add(this.world)
    this.scene.add(this.pivot)
    this.world.add(this.terrain, this.scenery.group, this.scope, this.highlights)
    this.selection.renderOrder = 10
    this.selection.visible = false
    this.hoverMesh.visible = false
    this.pathLine.renderOrder = 11
    this.world.add(this.selection, this.hoverMesh, this.pathLine)
    this.updateView()

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
        this.distance = THREE.MathUtils.clamp(this.distance * Math.exp(e.deltaY * 0.001), ZOOM_RANGE[0], ZOOM_RANGE[1])
        this.updateView()
      },
      { passive: false },
    )
  }

  /** Right drag spins and tilts the board, left drag slides it */
  private drag(button: number, dx: number, dy: number) {
    if (button === 2) {
      this.yaw += dx * 0.008
      this.tilt = THREE.MathUtils.clamp(this.tilt + dy * 0.004, TILT_RANGE[0], TILT_RANGE[1])
    } else if (button === 0) {
      const scale = this.distance / 900
      // Slide within the board plane so the camera keeps its height above the ground (the wheel handles that).
      // The ground is seen at a slant, so depth moves are stretched to follow the pointer
      const slant = Math.sin(VIEW_ELEVATION + this.tilt)
      this.pan.position.x += dx * scale
      this.pan.position.z += (dy * scale) / slant
    }
    this.updateView()
  }

  private updateView() {
    this.world.rotation.y = this.yaw
    this.pivot.rotation.x = this.tilt
    this.camera.position.set(0, this.distance * 0.69, this.distance * 0.72)
    this.camera.lookAt(0, 0.5, 0)
    // The haze starts just past the board, whatever the zoom
    const fog = this.scene.fog as THREE.Fog
    fog.near = this.distance - 2
    fog.far = this.distance + 14
  }

  /** Turns the board so the given player's starting row faces the camera */
  setSeatView(seat: Seat) {
    if (this.seatView === seat) return
    this.seatView = seat
    this.yaw = seat === 0 ? Math.PI : 0
    this.tilt = 0
    this.pan.position.set(0, 0, 0)
    this.updateView()
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

  /** Syncs the scene with a new game state; animates the last action if it's new */
  setState(state: GameState, animate: boolean) {
    if (state.heights.join() !== this.heights.join()) {
      this.buildTerrain(state.heights)
      for (const view of this.pieces.values()) this.world.remove(view.holder)
      this.pieces.clear()
      this.anims.clear()
      animate = false
    }

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
      const last = state.last
      if (animate && last && last.action.pieceId === piece.id) {
        const points = last.path.map((c) => this.cellTop(c))
        if (last.action.kind === "exit") {
          const off = points[points.length - 1].clone()
          off.z += piece.owner === 0 ? 1.2 : -1.2
          points.push(off)
        }
        this.anims.set(piece.id, { points, t: 0, fadeOut: piece.status === "finished" })
      } else if (animate && last?.captured === piece.id) {
        this.anims.set(piece.id, { points: [mesh.position.clone(), mesh.position.clone().setY(mesh.position.y - 0.6)], t: 0, fadeOut: true })
      } else if (piece.status === "board") {
        mesh.position.copy(this.cellTop(piece.cell))
      } else if (!this.anims.has(piece.id)) {
        this.world.remove(mesh)
        this.pieces.delete(piece.id)
      }
    }
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

    for (const [id, anim] of this.anims) {
      const view = this.pieces.get(id)!
      const mesh = view.holder
      const segments = anim.points.length - 1
      anim.t = Math.min(anim.t + dt * 5, segments)
      const i = Math.min(Math.floor(anim.t), segments - 1)
      const f = anim.t - i
      const a = anim.points[i],
        b = anim.points[i + 1]
      mesh.position.lerpVectors(a, b, f)
      // Hop over each square, higher when climbing or dropping
      mesh.position.y += Math.sin(f * Math.PI) * (0.25 + Math.abs(b.y - a.y) * 0.6)
      // Face the way it walks
      if (Math.abs(b.x - a.x) + Math.abs(b.z - a.z) > 0.01) view.model.rotation.y = Math.atan2(b.x - a.x, b.z - a.z)
      if (anim.fadeOut) setPieceOpacity(view, 1 - anim.t / segments)
      if (anim.t >= segments) {
        this.anims.delete(id)
        if (anim.fadeOut) {
          this.world.remove(mesh)
          this.pieces.delete(id)
        }
      }
    }

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
    this.scenery.update(now / 1000)
    this.renderer.render(this.scene, this.camera)
  }
}
