import { Application, Container, Graphics, Text, type TextStyleOptions } from "pixi.js"

export interface HudButton {
  label: string
  onClick: () => void
  active?: boolean
}

export interface HudModel {
  status: { color: number; label: string }[]
  turn: string
  right: string[]
  info: string[]
  modal: { title: string; body: string[]; buttons: HudButton[] } | null
  toast: string | null
}

const FONT = "system-ui, -apple-system, Segoe UI, sans-serif"
const PANEL = { color: 0x0e1014, alpha: 0.82 }
const text = (value: string, style: TextStyleOptions = {}) =>
  new Text({ text: value, style: { fontFamily: FONT, fontSize: 15, fill: 0xe8eaf0, ...style } })

/** 2D overlay drawn with Pixi on top of the Three.js board */
export class Hud {
  readonly app = new Application()
  private model: HudModel = { status: [], turn: "", right: [], info: [], modal: null, toast: null }
  private toastTimer = 0

  async init(canvas: HTMLCanvasElement) {
    await this.app.init({ canvas, backgroundAlpha: 0, antialias: true, resizeTo: window, autoDensity: true, resolution: devicePixelRatio })
    this.app.stage.eventMode = "passive"
    this.app.renderer.on("resize", () => this.draw())
  }

  /** True if the screen point is over an interactive HUD element (so the board should ignore it) */
  isOverHud(x: number, y: number) {
    return this.app.renderer.events.rootBoundary.hitTest(x, y) !== null
  }

  update(patch: Partial<HudModel>) {
    const next = { ...this.model, ...patch }
    // Button callbacks are looked up at click time, so only redraw when something visible changed
    const changed = JSON.stringify(next) !== JSON.stringify(this.model)
    this.model = next
    if (changed) this.draw()
  }

  toast(message: string) {
    clearTimeout(this.toastTimer)
    this.update({ toast: message })
    this.toastTimer = window.setTimeout(() => this.update({ toast: null }), 2600)
  }

  private panel(width: number, height: number, interactive = true) {
    const g = new Graphics().roundRect(0, 0, width, height, 10).fill(PANEL)
    // Panels swallow clicks so a click on the HUD never reaches the board
    if (interactive) g.eventMode = "static"
    return g
  }

  private draw() {
    const stage = this.app.stage
    for (const child of stage.removeChildren()) child.destroy({ children: true })
    const W = this.app.screen.width,
      H = this.app.screen.height
    const m = this.model

    // Top bar
    const bar = new Container()
    let x = 14
    for (const s of m.status) {
      bar.addChild(new Graphics().circle(x + 6, 21, 6).fill(s.color))
      const t = text(s.label, { fontWeight: "600" })
      t.position.set(x + 18, 11)
      bar.addChild(t)
      x += t.width + 36
    }
    const turn = text(m.turn, { fontSize: 17, fontWeight: "700", fill: 0xffe066 })
    turn.position.set(x + 6, 9)
    bar.addChild(turn)
    x += turn.width + 30
    const right = text(m.right.join("     "), { fill: 0xb8bdc9 })
    right.position.set(x, 11)
    bar.addChild(right)
    const barBg = this.panel(Math.min(W - 20, right.x + right.width + 16), 42)
    bar.addChildAt(barBg, 0)
    bar.position.set(10, 10)
    stage.addChild(bar)

    // Info panel (selected piece, attack preview, controls)
    if (m.info.length) {
      const info = new Container()
      const t = text(m.info.join("\n"), { fontSize: 14, lineHeight: 21, wordWrap: true, wordWrapWidth: Math.min(360, W - 60) })
      t.position.set(14, 10)
      info.addChild(this.panel(t.width + 28, t.height + 20, false), t)
      info.position.set(10, H - t.height - 30)
      stage.addChild(info)
    }

    if (m.toast) {
      const t = text(m.toast, { fontWeight: "600" })
      const box = new Container()
      t.position.set(16, 10)
      box.addChild(new Graphics().roundRect(0, 0, t.width + 32, t.height + 20, 10).fill({ color: 0x7a2020, alpha: 0.92 }), t)
      box.position.set((W - box.width) / 2, 64)
      stage.addChild(box)
    }

    if (m.modal) this.drawModal(m.modal, W, H)
  }

  private drawModal(modal: NonNullable<HudModel["modal"]>, W: number, H: number) {
    const width = Math.min(460, W - 32)
    const box = new Container()
    const title = text(modal.title, { fontSize: 24, fontWeight: "700" })
    title.position.set(24, 20)
    box.addChild(title)
    let y = title.y + title.height + 12
    for (const line of modal.body) {
      const t = text(line, { fill: 0xb8bdc9, wordWrap: true, wordWrapWidth: width - 48, breakWords: true })
      t.position.set(24, y)
      box.addChild(t)
      y += t.height + 6
    }
    y += 10
    let bx = 24
    modal.buttons.forEach((b, i) => {
      const label = text(b.label, { fontWeight: "600", fill: b.active ? 0x15171c : 0xe8eaf0 })
      const bw = label.width + 28,
        bh = 36
      if (bx + bw > width - 24) {
        bx = 24
        y += bh + 10
      }
      const btn = new Container()
      const bg = new Graphics().roundRect(0, 0, bw, bh, 8).fill(b.active ? 0xffe066 : 0x2b3040)
      label.position.set(14, (bh - label.height) / 2)
      btn.addChild(bg, label)
      btn.position.set(bx, y)
      btn.eventMode = "static"
      btn.cursor = "pointer"
      btn.on("pointerover", () => (bg.tint = 0xdddddd))
      btn.on("pointerout", () => (bg.tint = 0xffffff))
      btn.on("pointertap", () => this.model.modal?.buttons[i]?.onClick())
      box.addChild(btn)
      bx += bw + 10
    })
    const height = y + (modal.buttons.length ? 36 : 0) + 24
    box.addChildAt(this.panel(width, height), 0)
    box.position.set((W - width) / 2, (H - height) / 2)
    this.app.stage.addChild(box)
  }
}
