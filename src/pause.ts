import { TERRAIN_MODES, type TerrainMode } from "../shared/rules"
import type { Board3D } from "./board3d"
import { OFFICIAL_KINDS, type Session } from "./flow"
import type { Hud, HudButton } from "./hud"
import type { Net } from "./net"
import type { Webcam } from "./webcam"

/** Gives the first button of a row its caption */
function captioned(caption: string, buttons: HudButton[]) {
  if (buttons.length) buttons[0] = { ...buttons[0], caption }
  return buttons
}

/** Pause menu (Escape): restart, swap sides, change mode, resign, view and webcam, whatever the phase */
export class PauseMenu {
  /** Resigning takes a second click */
  private confirmResign = false

  constructor(
    private session: Session,
    private net: Net,
    private board: Board3D,
    private hud: Hud,
    private webcam: Webcam,
  ) {
    session.addEventListener("change", () => this.render())
    webcam.addEventListener("change", () => this.render())
    // Listeners nearer the page (a selected piece) take Escape first and mark it handled
    addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !e.defaultPrevented) this.toggle()
    })
  }

  toggle(open = !this.session.paused) {
    this.confirmResign = false
    this.session.set({ paused: open && this.session.online })
  }

  private render() {
    const s = this.session
    if (!s.paused) return this.hud.update({ pause: null })
    const close = () => this.toggle(false)
    const run = (action: () => void) => () => {
      action()
      close()
    }
    const { state, official, seat } = s
    const live = official?.phase === "playing" && !!state?.official && !state.over
    const buttons: HudButton[] = [{ label: "Reprendre", active: true, onClick: close }]

    if (seat !== null) {
      const game: HudButton[] = []
      if (live) {
        game.push({ label: "Proposer la nulle", onClick: run(() => this.net.send({ t: "officialOfferDraw" })) })
        game.push(
          this.confirmResign
            ? { label: "Confirmer l'abandon", danger: true, onClick: run(() => this.net.send({ t: "officialResign" })) }
            : { label: "Abandonner", onClick: () => ((this.confirmResign = true), this.render()) },
        )
      } else if (official) game.push({ label: "Revenir à la partie locale", onClick: run(() => this.net.send({ t: "officialLeave" })) })
      else {
        if (state) game.push({ label: "Relancer la partie", onClick: run(() => this.net.send({ t: "newGame", mode: state.mode })) })
        game.push({ label: "Échanger les camps", onClick: run(() => this.net.send({ t: "swapSeats" })) })
      }
      buttons.push(...captioned("Partie :", game))

      // A game on the site has to be resigned before switching to anything else
      if (!live) {
        const current: TerrainMode = state && !state.official ? state.mode : s.lobbyMode
        const terrains = Object.entries(TERRAIN_MODES).map(([mode, label]) => ({
          label,
          active: !official && mode === current,
          onClick: run(() => this.net.send({ t: "newGame", mode: mode as TerrainMode })),
        }))
        buttons.push(...captioned(official ? "Partie locale, terrain :" : "Nouvelle partie locale, terrain :", terrains))
        const kinds = OFFICIAL_KINDS.map(([kind, label]) => ({ label, onClick: run(() => this.net.send({ t: "official", kind })) }))
        buttons.push(...captioned("Sur traversalgame.com (avec ta session Firefox) :", kinds))
      }
    }

    const view: HudButton[] = [{ label: "Recentrer la vue", onClick: run(() => this.board.resetView()) }]
    // The webcam is for games between friends on this host, not on the site
    if (seat !== null && (!official || this.webcam.on)) {
      if (this.webcam.on) {
        view.push({ label: "Couper la webcam", onClick: run(() => this.webcam.stop()) })
        view.push({ label: this.webcam.micOn ? "Couper le micro" : "Rétablir le micro", onClick: run(() => this.webcam.toggleMic()) })
      } else view.push({ label: "Activer la webcam", onClick: run(() => this.webcam.start().catch((e) => this.hud.toast(e.message))) })
    }
    buttons.push(...captioned("Affichage :", view))

    this.hud.update({ pause: { title: "Pause", body: [this.summary(), "Échap : reprendre"], buttons } })
  }

  private summary() {
    const { state, official, seat } = this.session
    const who = seat === null ? "Tu regardes la partie" : `Tu joues ${seat === 0 ? "Rouge" : "Bleu"}`
    if (official) return `${who} · traversalgame.com : ${official.message}`
    if (!state) return `${who} · partie locale, en attente du second joueur`
    return `${who} · partie locale, terrain ${TERRAIN_MODES[state.mode]}, coup ${state.ply + 1}${state.over ? " (terminée)" : ""}`
  }
}
