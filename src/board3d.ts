import * as THREE from "three"
import { ConvexGeometry } from "three/examples/jsm/geometries/ConvexGeometry.js"
import { cellX, cellY, goalRow, N, type GameState, type LegalAction, type PieceType, type Seat } from "../shared/rules"

const STEP = 0.35 // world height of one terrain unit
const BASE = 0.4
const TEAM_COLORS = [0xd8443a, 0x3a7bd8]
/** A press is a click only if the pointer moved less than this between down and up (else it's a board drag) */
const CLICK_TOLERANCE_PX = 6
const TILT_RANGE = [-0.45, 0.4]
const ZOOM_RANGE = [9, 30]

export type Pick = { kind: "piece"; pieceId: number } | { kind: "cell"; cell: number } | { kind: "exit"; cell: number } | { kind: "none" }

const HEIGHT_COLORS = [0x2f6f8f, 0x4f9a6a, 0x7fb45a, 0xb7b25b, 0xa47c4a, 0x8a6a55, 0x8f8f94, 0xc4c4cc, 0xf1f1f5]

function pieceGeometry(type: PieceType): THREE.BufferGeometry {
  if (type === "explorer") return new THREE.CylinderGeometry(0, 0.34, 0.62, 5).translate(0, 0.31, 0)
  if (type === "sentinel") return new THREE.CylinderGeometry(0.3, 0.3, 0.56, 3).translate(0, 0.28, 0)
  // Vanguard: a diamond base rising to a two-point ridge
  const r = 0.34,
    h = 0.5
  return new ConvexGeometry([
    new THREE.Vector3(r, 0, 0),
    new THREE.Vector3(0, 0, r),
    new THREE.Vector3(-r, 0, 0),
    new THREE.Vector3(0, 0, -r),
    new THREE.Vector3(r * 0.45, h, 0),
    new THREE.Vector3(-r * 0.45, h, 0),
  ])
}

interface PieceAnim {
  points: THREE.Vector3[]
  t: number
  fadeOut: boolean
}

export class Board3D extends EventTarget {
  readonly renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  /** The camera and the lights never move: dragging tilts `pivot` and spins `world` (the board and its pieces) */
  private pivot = new THREE.Group()
  private world = new THREE.Group()
  private yaw = 0
  private tilt = 0
  private distance = 17.5
  private camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100)
  private raycaster = new THREE.Raycaster()
  private terrain = new THREE.Group()
  private highlights = new THREE.Group()
  private cellMeshes: THREE.Mesh[] = []
  private pieceMeshes = new Map<number, THREE.Mesh>()
  private exitMarkers: THREE.Mesh[] = []
  private anims = new Map<number, PieceAnim>()
  private heights: number[] = []
  private selection = new THREE.Mesh(
    new THREE.RingGeometry(0.36, 0.46, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xffe066, transparent: true, opacity: 0.95, depthTest: false }),
  )
  private hoverMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(0.96, 0.96).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false }),
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
    this.scene.background = new THREE.Color(0x15171c)

    this.scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x3a3020, 1.6))
    const sun = new THREE.DirectionalLight(0xffffff, 2.2)
    sun.position.set(-5, 12, 8)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    Object.assign(sun.shadow.camera, { left: -8, right: 8, top: 8, bottom: -8 })
    this.scene.add(sun)

    this.pivot.add(this.world)
    this.scene.add(this.pivot)
    this.world.add(this.terrain, this.highlights)
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

  /** Left drag spins and tilts the board, right drag slides it */
  private drag(button: number, dx: number, dy: number) {
    if (button === 0) {
      this.yaw += dx * 0.008
      this.tilt = THREE.MathUtils.clamp(this.tilt + dy * 0.004, TILT_RANGE[0], TILT_RANGE[1])
    } else if (button === 2) {
      const scale = this.distance / 900
      this.pivot.position.x += dx * scale
      this.pivot.position.y -= dy * scale
    }
    this.updateView()
  }

  private updateView() {
    this.world.rotation.y = this.yaw
    this.pivot.rotation.x = this.tilt
    this.camera.position.set(0, this.distance * 0.69, this.distance * 0.72)
    this.camera.lookAt(0, 0.5, 0)
  }

  /** Turns the board so the given player's starting row faces the camera */
  setSeatView(seat: Seat) {
    if (this.seatView === seat) return
    this.seatView = seat
    this.yaw = seat === 0 ? Math.PI : 0
    this.tilt = 0
    this.pivot.position.set(0, 0, 0)
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

  private buildTerrain(heights: number[]) {
    this.heights = heights
    this.terrain.clear()
    this.cellMeshes = []
    const edges = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.25 })
    for (let c = 0; c < N * N; c++) {
      const h = BASE + heights[c] * STEP
      const geo = new THREE.BoxGeometry(1, h, 1)
      const color = new THREE.Color(HEIGHT_COLORS[Math.min(heights[c], HEIGHT_COLORS.length - 1)])
      if ((cellX(c) + cellY(c)) % 2) color.offsetHSL(0, 0, -0.03)
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.9 }))
      const top = this.cellTop(c)
      mesh.position.set(top.x, h / 2, top.z)
      mesh.castShadow = mesh.receiveShadow = true
      mesh.userData.cell = c
      mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), edges))
      this.terrain.add(mesh)
      this.cellMeshes.push(mesh)
    }
    // Goal strips: each player exits past the far edge, drawn in their colour
    for (const seat of [0, 1] as Seat[]) {
      const strip = new THREE.Mesh(
        new THREE.BoxGeometry(N, 0.08, 0.35),
        new THREE.MeshStandardMaterial({ color: TEAM_COLORS[seat], emissive: TEAM_COLORS[seat], emissiveIntensity: 0.25 }),
      )
      strip.position.set(0, 0.04, (seat === 0 ? 1 : -1) * (N / 2 + 0.35))
      this.terrain.add(strip)
    }
  }

  /** Syncs the scene with a new game state; animates the last action if it's new */
  setState(state: GameState, animate: boolean) {
    if (state.heights.join() !== this.heights.join()) {
      this.buildTerrain(state.heights)
      for (const mesh of this.pieceMeshes.values()) this.world.remove(mesh)
      this.pieceMeshes.clear()
      this.anims.clear()
      animate = false
    }

    for (const piece of state.pieces) {
      let mesh = this.pieceMeshes.get(piece.id)
      if (!mesh) {
        if (piece.status !== "board") continue
        mesh = new THREE.Mesh(
          pieceGeometry(piece.type),
          new THREE.MeshStandardMaterial({ color: TEAM_COLORS[piece.owner], metalness: 0.3, roughness: 0.45, transparent: true }),
        )
        mesh.castShadow = true
        mesh.userData.pieceId = piece.id
        mesh.position.copy(this.cellTop(piece.cell))
        this.world.add(mesh)
        this.pieceMeshes.set(piece.id, mesh)
      }
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
        this.pieceMeshes.delete(piece.id)
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
        new THREE.PlaneGeometry(0.8, 0.8).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: a.kind === "attack" ? 0.7 : 0.5, depthWrite: false }),
      )
      tile.position.copy(this.cellTop(a.to, 0.015))
      this.highlights.add(tile)
    }
  }

  /** Highlights the hovered square and the path the piece would take */
  showHover(cell: number | null, path: number[] = []) {
    this.hoverMesh.visible = cell !== null
    if (cell !== null) this.hoverMesh.position.copy(this.cellTop(cell, 0.02))
    this.pathLine.geometry.dispose()
    this.pathLine.geometry = new THREE.BufferGeometry().setFromPoints(path.map((c) => this.cellTop(c, 0.12)))
  }

  private pickAt(clientX: number, clientY: number): Pick {
    const rect = this.canvas.getBoundingClientRect()
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
    this.raycaster.setFromCamera(ndc, this.camera)
    const targets = [...this.exitMarkers, ...this.pieceMeshes.values(), ...this.cellMeshes]
    const hit = this.raycaster.intersectObjects(targets, false)[0]
    if (!hit) return { kind: "none" }
    const data = hit.object.userData
    if (data.exitCell !== undefined) return { kind: "exit", cell: data.exitCell }
    if (data.pieceId !== undefined) return { kind: "piece", pieceId: data.pieceId }
    if (data.cell !== undefined) return { kind: "cell", cell: data.cell }
    return { kind: "none" }
  }

  render() {
    const now = performance.now()
    const dt = Math.min((now - this.lastTime) / 1000, 0.1)
    this.lastTime = now

    for (const [id, anim] of this.anims) {
      const mesh = this.pieceMeshes.get(id)!
      const segments = anim.points.length - 1
      anim.t = Math.min(anim.t + dt * 5, segments)
      const i = Math.min(Math.floor(anim.t), segments - 1)
      const f = anim.t - i
      const a = anim.points[i],
        b = anim.points[i + 1]
      mesh.position.lerpVectors(a, b, f)
      // Hop over each square, higher when climbing or dropping
      mesh.position.y += Math.sin(f * Math.PI) * (0.25 + Math.abs(b.y - a.y) * 0.6)
      const material = mesh.material as THREE.MeshStandardMaterial
      if (anim.fadeOut) material.opacity = 1 - anim.t / segments
      if (anim.t >= segments) {
        this.anims.delete(id)
        if (anim.fadeOut) {
          this.world.remove(mesh)
          this.pieceMeshes.delete(id)
        }
      }
    }

    this.selection.material.opacity = 0.7 + Math.sin(now / 200) * 0.25
    this.renderer.render(this.scene, this.camera)
  }
}
