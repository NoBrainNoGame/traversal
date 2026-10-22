import { ChipBase, Composite, Signal, StateMachine } from "@ghom/booyah"
import { legalActions, PIECES, pieceAt, pieceScope, TERRAIN_MODES, type GameState, type LegalAction, type Seat, type TerrainMode } from "../shared/rules"
import type { Board3D, Pick, ScopeMark } from "./board3d"
import { STANDALONE, type Host } from "./host"
import type { Hud, HudButton } from "./hud"
import type { OfficialKind, OfficialStatus } from "./official"
import { account } from "./relay"
import type { Sound } from "./sound"

/** Everything the client knows, fed by the host; emits "change" */
export class Session extends EventTarget {
  online = false
  seat: Seat | null = null
  urls: string[] = []
  /** The same addresses over https: the friend needs them for the webcam */
  secureUrls: string[] = []
  /** The pause menu is open */
  paused = false
  connected: [boolean, boolean] = [false, false]
  lobbyMode: TerrainMode = "balanced"
  state: GameState | null = null
  /** Set while a game on traversalgame.com is being set up or played */
  official: OfficialStatus | null = null
  /** When the last state arrived (local clock), to run the official clocks between updates */
  stateReceivedAt = 0
  /** The traversalgame.com account: null when logged out, "" until its name is known */
  account: string | null = null

  set(patch: Partial<Session>) {
    Object.assign(this, patch)
    this.dispatchEvent(new Event("change"))
  }

  get myTurn() {
    return !!this.state && !this.state.over && this.state.turn === this.seat
  }
}

type Phase = "connecting" | "lobby" | "official" | "playing" | "over"

function phaseOf(session: Session): Phase {
  if (!session.online) return "connecting"
  if (session.official) {
    const { phase } = session.official
    if ((phase === "playing" || phase === "over") && session.state?.official) return session.state.over ? "over" : "playing"
    return "official"
  }
  if (!session.state) return "lobby"
  return session.state.over ? "over" : "playing"
}

const CONTROLS = ["Clic gauche glissé : déplacer · Clic droit : tourner · Molette : zoom", STANDALONE ? "Échap : menu" : "Échap : menu · Entrée : discuter"]
const SCOPE_LEGEND = "Vert : coût de déplacement · Rouge : bonus d'attaque (gris : attaque perdue)"

function hoveredPiece(state: GameState, pick: Pick): number | undefined {
  if (pick.kind === "piece") return pick.pieceId
  if (pick.kind === "cell") return pieceAt(state, pick.cell)?.id
}

/** A piece's reach as tags: walking cost on free squares, attack modifier (height, charge, support) on enemies */
function scopeMarks(state: GameState, pieceId: number): ScopeMark[] {
  const strength = PIECES[state.pieces[pieceId].type].strength
  return pieceScope(state, pieceId).flatMap((la): ScopeMark[] => {
    if (la.action.kind === "move") return [{ cell: la.action.to, kind: "move", label: String(la.cost) }]
    if (la.action.kind === "attack" && la.attack) {
      const mod = la.attack.attack - strength
      const label = mod > 0 ? `+${mod}` : mod < 0 ? String(mod) : "±0"
      return [{ cell: la.action.to, kind: "attack", label, muted: la.attack.attack < la.attack.defense }]
    }
    return []
  })
}

function pieceInfo(state: GameState, pieceId: number) {
  const piece = state.pieces[pieceId]
  const def = PIECES[piece.type]
  return [`${def.name} ${piece.owner === 0 ? "rouge" : "bleu"} — Mouvement ${def.move} · Force ${def.strength}`, def.special, SCOPE_LEGEND]
}


/** Base for the chips below: typed access to the services in the chip context */
abstract class AppChip extends ChipBase {
  /** Hovering any piece shows its reach and what it is, whoever's turn it is */
  protected previewOnHover(turn: string, idleInfo: string[]) {
    this._subscribe(this.board, "hover", (e: CustomEvent<Pick>) => {
      const state = this.session.state
      const id = state ? hoveredPiece(state, e.detail) : undefined
      this.board.showScope(state && id !== undefined ? scopeMarks(state, id) : [])
      this.hud.update({ turn, info: state && id !== undefined ? pieceInfo(state, id) : idleInfo })
    })
  }

  protected get host(): Host {
    return this.chipContext.host
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
  protected get sound(): Sound {
    return this.chipContext.sound
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

export const OFFICIAL_KINDS: [OfficialKind, string][] = [
  ["bot", "Contre un bot"],
  ["match", "Matchmaking"],
  ["friend", "Inviter un ami"],
]

function officialButtons(session: Session, host: Host, caption = "Sur traversalgame.com :") {
  if (session.seat === null && !session.official && !STANDALONE) return []
  return OFFICIAL_KINDS.map(([kind, label], i) => ({
    label,
    caption: i === 0 ? caption : undefined,
    onClick: () => host.send({ t: "official", kind }),
  }))
}

/** Who is logged in on traversalgame.com, with the button to log out */
export function accountLine(session: Session): { text: string; button: HudButton | null } {
  if (session.account === null) return { text: "Pas connecté à traversalgame.com : ton e-mail et ton mot de passe te seront demandés.", button: null }
  return {
    text: `Connecté à traversalgame.com${session.account ? ` en tant que ${session.account}` : ""}.`,
    button: { label: "Se déconnecter", onClick: () => void account.logout() },
  }
}

function terrainButtons(session: Session, host: Host, current: TerrainMode) {
  if (session.seat === null) return []
  return Object.entries(TERRAIN_MODES).map(([mode, label]) => ({
    label,
    active: mode === current,
    onClick: () => host.send({ t: "newGame", mode: mode as TerrainMode }),
  }))
}

class Lobby extends PhaseChip {
  protected readonly phase = "lobby"

  protected enter() {
    this.refresh()
  }

  protected refresh() {
    const s = this.session
    if (STANDALONE) {
      const { text, button } = accountLine(s)
      const body = ["Joue tes parties traversalgame.com dans ce client 3D.", text, ""]
      const buttons = officialButtons(s, this.host, "Nouvelle partie :")
      if (button) buttons.push({ ...button, caption: "Compte :" })
      this.hud.update({ modal: { title: "Traversal", body, buttons } })
      return
    }
    const body =
      s.seat === null
        ? ["La partie est déjà complète."]
        : [
            "En attente de ton ami…",
            s.urls.length ? `Il doit ouvrir : ${s.urls.join("  ou  ")}` : "Aucune adresse réseau trouvée sur cette machine.",
            ...(s.secureUrls.length ? [`Avec webcam : ${s.secureUrls.join("  ou  ")} (accepter l'avertissement du certificat)`] : []),
            "",
            "Partie locale, terrain :",
          ]
    this.hud.update({ modal: { title: "Traversal", body, buttons: [...terrainButtons(s, this.host, s.lobbyMode), ...officialButtons(s, this.host)] } })
  }
}

/** Setting up a game on traversalgame.com: searching, waiting for a friend, or an error */
class Official extends PhaseChip {
  protected readonly phase = "official"

  protected enter() {
    this.board.showActions(null, [])
    this.board.showHover(null)
    this.board.showScope([])
    this.refresh()
  }

  protected refresh() {
    const status = this.session.official
    if (!status) return
    const leave = (label: string) => ({ label, onClick: () => this.host.send({ t: "officialLeave" }) })
    const body = [status.message]
    if (status.link) body.push("", status.link)
    let buttons: HudButton[] = [leave("Annuler")]
    if (status.phase === "ghost")
      buttons = [
        { label: "Jouer contre le bot", active: true, onClick: () => this.host.send({ t: "officialGhost", accept: true }) },
        { label: "Continuer à chercher", onClick: () => this.host.send({ t: "officialGhost", accept: false }) },
        leave("Annuler"),
      ]
    else if (status.phase === "error") buttons = [leave("Retour")]
    if (status.login) buttons.unshift({ label: "Se connecter", active: true, onClick: () => this.host.send({ t: "officialRetry" }) })
    if (status.link) buttons.unshift({ label: "Copier le lien", active: true, onClick: () => void navigator.clipboard?.writeText(status.link!) })
    this.hud.update({ turn: "", info: [], modal: { title: "traversalgame.com", body, buttons } })
  }
}

class Over extends PhaseChip {
  protected readonly phase = "over"

  protected enter() {
    this.board.showActions(null, [])
    this.board.showHover(null)
    this.board.showScope([])
    this.refresh()
  }

  protected refresh() {
    const s = this.session,
      state = s.state!
    const title =
      state.winner === null ? "Match nul" : s.seat === null ? `${state.winner === 0 ? "Rouge" : "Bleu"} gagne` : state.winner === s.seat ? "Victoire !" : "Défaite"
    const body = [state.reason + ".", `Score : Rouge ${state.score[0]} – ${state.score[1]} Bleu`, ""]
    if (s.official) {
      const back = STANDALONE ? "Retour au menu" : "Revenir au mode local"
      const buttons: HudButton[] = [...officialButtons(s, this.host, "Rejouer sur traversalgame.com :"), { label: back, caption: "Ou bien :", onClick: () => this.host.send({ t: "officialLeave" }) }]
      this.hud.update({ turn: "", info: [], modal: { title, body, buttons } })
      return
    }
    body.push("Rejouer sur :")
    this.hud.update({ turn: "", info: [], modal: { title, body, buttons: terrainButtons(s, this.host, state.mode) } })
  }
}

/** The game itself; runs the turn state machine below while the game is on */
class Playing extends Composite {
  protected _onActivate() {
    const session: Session = this.chipContext.session
    this.chipContext.hud.update({ modal: null })
    this._subscribe(session, "change", () => {
      const phase = phaseOf(session)
      if (phase !== "playing" && this.state === "active") return this.terminate(new Signal(phase))
      this.showDrawOffer()
    })
    this._activateChildChip(
      new StateMachine(
        { waiting: () => new Waiting(), idle: () => new Idle(), selected: () => new Selected(), sending: () => new Sending() },
        { startingState: "waiting" },
      ),
    )
  }

  private showDrawOffer() {
    this.chipContext.hud.update({ modal: drawOfferModal(this.chipContext.session, this.chipContext.host) })
  }
}

// ------------------------------------------------------------------ turn states

/** On traversalgame.com the opponent can offer a draw */
function drawOfferModal(session: Session, host: Host) {
  const from = session.official?.drawOffer
  if (!from) return null
  return {
    title: "Proposition de nulle",
    body: [`${from} propose une partie nulle.`],
    buttons: [
      { label: "Accepter", active: true, onClick: () => host.send({ t: "officialDraw", accept: true }) },
      { label: "Refuser", onClick: () => host.send({ t: "officialDraw", accept: false }) },
    ],
  }
}

/** Opponent's turn (or spectating) */
class Waiting extends AppChip {
  protected _onActivate() {
    this.board.showActions(null, [])
    this.board.showHover(null)
    this.board.showScope([])
    const turn = this.session.seat === null ? "Spectateur" : "Tour de l'adversaire"
    this.hud.update({ turn, info: CONTROLS })
    this.previewOnHover(turn, CONTROLS)
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
    this.board.showScope([])
    const info = ["Clique sur une de tes pièces.", ...CONTROLS]
    this.hud.update({ turn: "À toi de jouer", info })
    this.previewOnHover("À toi de jouer", info)
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
  private hovered: number | null = null

  protected _onActivate() {
    this.pieceId = this._inputSignal!.params.pieceId
    this.sound.ui("select")
    this.computeActions()
    this._subscribe(this.board, "pick", (e: CustomEvent<Pick>) => this.onPick(e.detail))
    this._subscribe(this.board, "hover", (e: CustomEvent<Pick>) => this.onHover(e.detail))
    // On the document, so this runs before the pause menu's listener and keeps Escape from also opening it
    this._subscribe(document, "keydown", (e: KeyboardEvent) => {
      if (e.key !== "Escape" || this.session.paused) return
      e.preventDefault()
      this.terminate(new Signal("idle"))
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
    // The move highlights already tint the squares, the tags add costs and attack odds
    this.board.showScope(scopeMarks(state, this.pieceId), false)
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
    lines.push(SCOPE_LEGEND, "Échap ou clic dans le vide : désélectionner")
    this.hud.update({ turn: "À toi de jouer", info: lines })
  }

  private onHover(pick: Pick) {
    const la = actionFor(this.session.state!, this.actions, pick)
    const target = la ? (la.action.kind === "exit" ? la.action.from : la.action.to) : null
    if (target !== null && target !== this.hovered) this.sound.ui("tick")
    this.hovered = target
    this.board.showHover(target, la?.path)
    this.showInfo(la)
  }

  private onPick(pick: Pick) {
    const state = this.session.state!
    const la = actionFor(state, this.actions, pick)
    if (la) {
      this.host.send({ t: "action", action: la.action })
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
    this.board.showScope([])
    this._subscribe(this.session, "change", () => {
      if (this.state === "active" && this.session.state && this.session.state.ply !== ply)
        this.terminate(new Signal(this.session.myTurn ? "idle" : "waiting"))
    })
    this._subscribe(this.host, "error", () => {
      this.sound.ui("error")
      this.terminate(new Signal("idle"))
    })
  }
}

export function makeAppMachine() {
  return new StateMachine(
    {
      connecting: () => new Connecting(),
      lobby: () => new Lobby(),
      official: () => new Official(),
      playing: () => new Playing(),
      over: () => new Over(),
    },
    { startingState: "connecting" },
  )
}
