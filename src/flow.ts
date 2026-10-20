import { ChipBase, Composite, Signal, StateMachine } from "@ghom/booyah"
import { legalActions, PIECES, pieceAt, TERRAIN_MODES, type GameState, type LegalAction, type Seat, type TerrainMode } from "../shared/rules"
import type { Board3D, Pick } from "./board3d"
import type { Hud } from "./hud"
import type { Net } from "./net"

/** Everything the client knows, fed by the network; emits "change" */
export class Session extends EventTarget {
  online = false
  seat: Seat | null = null
  urls: string[] = []
  connected: [boolean, boolean] = [false, false]
  lobbyMode: TerrainMode = "balanced"
  state: GameState | null = null

  set(patch: Partial<Session>) {
    Object.assign(this, patch)
    this.dispatchEvent(new Event("change"))
  }

  get myTurn() {
    return !!this.state && !this.state.over && this.state.turn === this.seat
  }
}

type Phase = "connecting" | "lobby" | "playing" | "over"

function phaseOf(session: Session): Phase {
  if (!session.online) return "connecting"
  if (!session.state) return "lobby"
  return session.state.over ? "over" : "playing"
}

const CONTROLS = ["Clic gauche glissé : déplacer · Clic droit : tourner · Molette : zoom"]

/** Base for the chips below: typed access to the services in the chip context */
abstract class AppChip extends ChipBase {
  protected get net(): Net {
    return this.chipContext.net
  }
  protected get board(): Board3D {
    return this.chipContext.board
  }
  protected get hud(): Hud {
    return this.chipContext.hud
  }
  protected get session(): Session {
    return this.chipContext.session
  }
}

/** A top-level phase: leaves as soon as the session says we belong to another phase */
abstract class PhaseChip extends AppChip {
  protected abstract readonly phase: Phase

  protected _onActivate() {
    this._subscribe(this.session, "change", () => this.checkPhase())
    this.enter()
    this.checkPhase()
  }

  protected abstract enter(): void

  protected refresh() {}

  private checkPhase() {
    if (this.state !== "active") return
    const phase = phaseOf(this.session)
    if (phase !== this.phase) this.terminate(new Signal(phase))
    else this.refresh()
  }
}

class Connecting extends PhaseChip {
  protected readonly phase = "connecting"

  protected enter() {
    this.hud.update({ modal: { title: "Traversal", body: ["Connexion à l'hôte…"], buttons: [] } })
  }
}

function terrainButtons(session: Session, net: Net, current: TerrainMode) {
  if (session.seat === null) return []
  return Object.entries(TERRAIN_MODES).map(([mode, label]) => ({
    label,
    active: mode === current,
    onClick: () => net.send({ t: "newGame", mode: mode as TerrainMode }),
  }))
}

class Lobby extends PhaseChip {
  protected readonly phase = "lobby"

  protected enter() {
    this.refresh()
  }

  protected refresh() {
    const s = this.session
    const body =
      s.seat === null
        ? ["La partie est déjà complète."]
        : [
            "En attente de ton ami…",
            s.urls.length ? `Il doit ouvrir : ${s.urls.join("  ou  ")}` : "Aucune adresse réseau trouvée sur cette machine.",
            "",
            "Terrain :",
          ]
    this.hud.update({ modal: { title: "Traversal", body, buttons: terrainButtons(s, this.net, s.lobbyMode) } })
  }
}

class Over extends PhaseChip {
  protected readonly phase = "over"

  protected enter() {
    this.board.showActions(null, [])
    this.board.showHover(null)
    this.refresh()
  }

  protected refresh() {
    const s = this.session,
      state = s.state!
    const title =
      state.winner === null ? "Match nul" : s.seat === null ? `${state.winner === 0 ? "Rouge" : "Bleu"} gagne` : state.winner === s.seat ? "Victoire !" : "Défaite"
    const body = [state.reason + ".", `Score : Rouge ${state.score[0]} – ${state.score[1]} Bleu`, "", "Rejouer sur :"]
    this.hud.update({ turn: "", info: [], modal: { title, body, buttons: terrainButtons(s, this.net, state.mode) } })
  }
}

/** The game itself; runs the turn state machine below while the game is on */
class Playing extends Composite {
  protected _onActivate() {
    const session: Session = this.chipContext.session
    this.chipContext.hud.update({ modal: null })
    this._subscribe(session, "change", () => {
      const phase = phaseOf(session)
      if (phase !== "playing" && this.state === "active") this.terminate(new Signal(phase))
    })
    this._activateChildChip(
      new StateMachine(
        { waiting: () => new Waiting(), idle: () => new Idle(), selected: () => new Selected(), sending: () => new Sending() },
        { startingState: "waiting" },
      ),
    )
  }
}

// ------------------------------------------------------------------ turn states

/** Opponent's turn (or spectating) */
class Waiting extends AppChip {
  protected _onActivate() {
    this.board.showActions(null, [])
    this.board.showHover(null)
    this.hud.update({ turn: this.session.seat === null ? "Spectateur" : "Tour de l'adversaire", info: CONTROLS })
    this._subscribe(this.session, "change", () => this.check())
    this.check()
  }

  private check() {
    if (this.state === "active" && this.session.myTurn) this.terminate(new Signal("idle"))
  }
}

/** My turn, nothing selected */
class Idle extends AppChip {
  protected _onActivate() {
    this.board.showActions(null, [])
    this.board.showHover(null)
    this.hud.update({ turn: "À toi de jouer", info: ["Clique sur une de tes pièces.", ...CONTROLS] })
    this._subscribe(this.board, "pick", (e: CustomEvent<Pick>) => {
      const pieceId = ownPiece(this.session, e.detail)
      if (pieceId !== null) this.terminate(new Signal("selected", { pieceId }))
    })
    this._subscribe(this.session, "change", () => {
      if (this.state === "active" && !this.session.myTurn) this.terminate(new Signal("waiting"))
    })
  }
}

function ownPiece(session: Session, pick: Pick): number | null {
  const state = session.state!
  const id = pick.kind === "piece" ? pick.pieceId : pick.kind === "cell" ? pieceAt(state, pick.cell)?.id : undefined
  if (id === undefined || state.pieces[id].owner !== session.seat) return null
  return id
}

/** Finds which of the selected piece's actions the pick points at */
function actionFor(state: GameState, actions: LegalAction[], pick: Pick): LegalAction | undefined {
  let cell: number | null = null
  if (pick.kind === "exit") return actions.find((la) => la.action.kind === "exit" && la.action.from === pick.cell)
  if (pick.kind === "cell") cell = pick.cell
  if (pick.kind === "piece") cell = state.pieces[pick.pieceId].cell
  return actions.find((la) => la.action.kind !== "exit" && la.action.to === cell)
}

/** A piece is selected: its options are shown, hovering previews them, clicking one plays it */
class Selected extends AppChip {
  private pieceId = -1
  private actions: LegalAction[] = []

  protected _onActivate() {
    this.pieceId = this._inputSignal!.params.pieceId
    this.computeActions()
    this._subscribe(this.board, "pick", (e: CustomEvent<Pick>) => this.onPick(e.detail))
    this._subscribe(this.board, "hover", (e: CustomEvent<Pick>) => this.onHover(e.detail))
    this._subscribe(window, "keydown", (e: KeyboardEvent) => {
      if (e.key === "Escape") this.terminate(new Signal("idle"))
    })
    this._subscribe(this.session, "change", () => {
      if (this.state !== "active") return
      if (!this.session.myTurn) this.terminate(new Signal("waiting"))
      else this.computeActions()
    })
  }

  private computeActions() {
    const state = this.session.state!
    this.actions = legalActions(state, this.pieceId)
    this.board.showActions(state.pieces[this.pieceId].cell, this.actions)
    this.showInfo()
  }

  private showInfo(preview?: LegalAction) {
    const piece = this.session.state!.pieces[this.pieceId]
    const def = PIECES[piece.type]
    const lines = [`${def.name} — Mouvement ${def.move} · Force ${def.strength}`, def.special]
    if (!this.actions.length) lines.push("Aucun coup possible pour cette pièce.")
    if (preview?.attack) lines.push(`Attaque ${preview.attack.attack} contre défense ${preview.attack.defense} → capture`)
    else if (preview?.action.kind === "exit") lines.push(`Sortie du plateau : +${def.strength} point${def.strength > 1 ? "s" : ""}`)
    else if (preview) lines.push(`Coût : ${preview.cost} / ${def.move}`)
    lines.push("Échap ou clic dans le vide : désélectionner")
    this.hud.update({ turn: "À toi de jouer", info: lines })
  }

  private onHover(pick: Pick) {
    const la = actionFor(this.session.state!, this.actions, pick)
    const target = la ? (la.action.kind === "exit" ? la.action.from : la.action.to) : null
    this.board.showHover(target, la?.path)
    this.showInfo(la)
  }

  private onPick(pick: Pick) {
    const state = this.session.state!
    const la = actionFor(state, this.actions, pick)
    if (la) {
      this.net.send({ t: "action", action: la.action })
      this.terminate(new Signal("sending", { ply: state.ply }))
      return
    }
    // Clicking another of my pieces switches the selection instead of doing anything else
    const other = ownPiece(this.session, pick)
    if (other !== null && other !== this.pieceId) this.terminate(new Signal("selected", { pieceId: other }))
    else this.terminate(new Signal("idle"))
  }
}

/** Action sent, waiting for the host to confirm it */
class Sending extends AppChip {
  protected _onActivate() {
    const ply = this._inputSignal!.params.ply
    this.board.showHover(null)
    this._subscribe(this.session, "change", () => {
      if (this.state === "active" && this.session.state && this.session.state.ply !== ply)
        this.terminate(new Signal(this.session.myTurn ? "idle" : "waiting"))
    })
    this._subscribe(this.net, "error", () => this.terminate(new Signal("idle")))
  }
}

export function makeAppMachine() {
  return new StateMachine(
    {
      connecting: () => new Connecting(),
      lobby: () => new Lobby(),
      playing: () => new Playing(),
      over: () => new Over(),
    },
    { startingState: "connecting" },
  )
}
