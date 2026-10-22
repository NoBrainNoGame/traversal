// Plays games on traversalgame.com (with its developer's permission) through the Cloudflare relay (see relay.ts).
// The official server stays authoritative: its states are translated into ours for the 3D client, our actions
// into its moves. Protocol notes: REST on api.traversalgame.com, one WebSocket per game, JSON {type, payload}.

import { cellAt, cellX, cellY, goalRow, inBoard, N, pieceScope, type Action, type GameState, type LegalAction, type Piece, type PieceType, type Seat } from "../shared/rules"
import { account, errorMessage, OfficialError, type ApiResult } from "./relay"

const SITE = "https://www.traversalgame.com"
const BOT_DIFFICULTY = 5
const TIME_CONTROL = "10+0"
/** Close codes after which the official web client gives up instead of reconnecting */
const TERMINAL_CLOSE = [4001, 4003, 4004, 4008]

export type OfficialKind = "bot" | "match" | "friend"

/** Where a game on traversalgame.com stands, before and during play */
export interface OfficialStatus {
  phase: "starting" | "searching" | "ghost" | "waiting" | "playing" | "over" | "error"
  message: string
  /** Invite link to send to a friend */
  link?: string
  /** The session is missing or expired: offer to log in */
  login?: boolean
  /** Username of an opponent offering a draw */
  drawOffer?: string
}

const REASONS: Record<string, string> = {
  resign: "Abandon",
  resignation: "Abandon",
  timeout: "Temps écoulé",
  abandoned: "Partie abandonnée",
  draw_accepted: "Nulle acceptée",
  threefold_repetition: "Triple répétition",
  move_limit: "Limite de 200 coups",
  move_limit_score: "Limite de 200 coups (score)",
  move_limit_advancement: "Limite de 200 coups (avancée)",
  no_show: "L'adversaire ne s'est jamais présenté",
  insufficient_moves: "Pas assez de coups joués",
}
const VICTORIES: Record<string, string> = { total_domination: "Domination totale", perfect_game: "Partie parfaite" }

// ------------------------------------------------------------------ official shapes

interface OfficialPiece {
  id: string
  type: PieceType
  player: 1 | 2
  row: number
  col: number
  is_captured: boolean
  is_finished: boolean
}

interface ValidMove {
  to_row: number
  to_col: number
  cost: number
  is_attack: boolean
  captured_id?: string
  can_finish?: boolean
}

interface MoveRecord {
  moveNumber: number
  pieceId: string
  fromRow: number
  fromCol: number
  toRow: number
  toCol: number
}

/** Official rows run from player 1's side (row 9) to player 2's (row 0); our y runs from seat 0's side (y 0) */
const toCell = (row: number, col: number) => cellAt(col, N - 1 - Math.min(Math.max(row, 0), N - 1))
const offBoard = (row: number) => row < 0 || row >= N

// ------------------------------------------------------------------ a game on the official site

export class OfficialGame {
  status: OfficialStatus = { phase: "starting", message: "Connexion à traversalgame.com…" }
  state: GameState | null = null
  /** Which side we play, once the server has said so */
  seat: Seat | null = null
  private gameId: string | null = null
  private ws: WebSocket | null = null
  private poll = 0
  private reconnect = 0
  private closed = false
  private refreshedForSocket = false
  /** Our piece id -> official piece id */
  private ids: string[] = []
  /** The official move behind each legal action we offer, so it is sent back verbatim */
  private sourceMoves = new Map<string, ValidMove>()

  constructor(
    private onChange: () => void,
    private onNotice: (message: string) => void,
  ) {}

  async start(kind: OfficialKind) {
    try {
      const me = await account.api("/me")
      if (!me.ok) throw new OfficialError(errorMessage(me.data, "Impossible de lire ton compte traversalgame.com."))
      const name = me.data?.username ?? "toi"
      if (kind === "bot") {
        this.setStatus("starting", `Connecté en tant que ${name}. Création d'une partie contre un bot (niveau ${BOT_DIFFICULTY})…`)
        const res = await account.api("/api/games/vs-bot", "POST", { terrain: "random", difficulty: BOT_DIFFICULTY, player_side: null, time_control: TIME_CONTROL })
        this.openGame(res, "Impossible de créer la partie contre le bot.")
      } else if (kind === "friend") {
        this.setStatus("starting", `Connecté en tant que ${name}. Création d'une partie privée…`)
        const res = await account.api("/api/games", "POST", { terrain: "random", play_as: "random", private: true, ranked: false })
        this.openGame(res, "Impossible de créer la partie privée.")
      } else {
        this.setStatus("searching", `Connecté en tant que ${name}. Recherche d'un adversaire…`)
        const res = await account.api("/api/games/find", "POST", { terrain: "random", ranked: false })
        if (this.resumeActive(res)) return
        if (!res.ok) throw new OfficialError(errorMessage(res.data, "Impossible de lancer la recherche."))
        this.onFindStatus(res.data)
        if (!this.gameId) this.poll = window.setInterval(() => this.checkFind(), 2000)
      }
    } catch (e) {
      this.fail(e)
    }
  }

  /** A 409 means a game is already going on for this account: play that one */
  private resumeActive(res: ApiResult) {
    const id = res.status === 409 ? res.data?.detail?.game_id : null
    if (!id) return false
    this.onNotice("Tu as déjà une partie en cours sur le site : reprise de cette partie.")
    this.connect(id)
    return true
  }

  private openGame(res: ApiResult, fallback: string) {
    if (this.resumeActive(res)) return
    if (!res.ok || !res.data?.game_id) throw new OfficialError(errorMessage(res.data, fallback))
    this.connect(res.data.game_id)
  }

  private async checkFind() {
    if (this.closed) return
    try {
      const res = await account.api("/api/games/find/status")
      if (res.ok) this.onFindStatus(res.data)
    } catch (e) {
      this.fail(e)
    }
  }

  private onFindStatus(data: any) {
    if (data?.status === "matched" && data.game_id) {
      this.stopPolling()
      this.connect(data.game_id)
    } else if (data?.status === "ghost_offered" && this.status.phase !== "ghost") {
      this.setStatus("ghost", "Personne de disponible pour l'instant. Jouer contre un bot à la place ?")
    }
  }

  async answerGhost(accept: boolean) {
    try {
      if (!accept) {
        await account.api("/api/games/find/decline-bot", "POST")
        this.setStatus("searching", "Recherche d'un adversaire…")
        return
      }
      const res = await account.api("/api/games/find/accept-bot", "POST")
      if (res.ok && res.data?.game_id) {
        this.stopPolling()
        this.connect(res.data.game_id)
      }
    } catch (e) {
      this.fail(e)
    }
  }

  answerDraw(accept: boolean) {
    this.send("respond_draw", { accept })
    this.status = { ...this.status, drawOffer: undefined }
    this.onChange()
  }

  /** True while a game is being played (it can't just be left: resign first) */
  get live() {
    return this.status.phase === "playing" && !!this.state && !this.state.over
  }

  offerDraw() {
    if (!this.live) return
    this.send("offer_draw", {})
    this.onNotice("Nulle proposée à l'adversaire.")
  }

  resign() {
    if (this.live) this.send("resign", {})
  }

  /** Sends one of the legal actions offered in the current state; returns an error message if it can't */
  play(action: Action): string | null {
    const state = this.state
    if (!state?.official || this.seat === null) return "La partie n'a pas commencé."
    if (state.turn !== this.seat || state.over) return "Ce n'est pas ton tour."
    const move = this.sourceMoves.get(actionKey(action))
    if (!move) return "Coup refusé : il n'est pas dans la liste du serveur officiel."
    this.send("make_move", { piece_id: this.ids[action.pieceId], to_pos: [move.to_row, move.to_col], finish: !!move.can_finish || offBoard(move.to_row) })
    return null
  }

  /** Leaves: cancels the search or the invite if the game hasn't started, and stops listening */
  async leave() {
    const phase = this.status.phase
    this.closed = true
    this.stopPolling()
    clearTimeout(this.reconnect)
    this.ws?.close()
    try {
      if (phase === "searching" || phase === "ghost") await account.api("/api/games/find", "DELETE")
      if (phase === "waiting" && this.gameId) await account.api(`/api/games/${this.gameId}/cancel`, "POST")
    } catch {}
  }

  // ---------------------------------------------------------------- game socket

  private connect(gameId: string) {
    if (this.closed) return
    this.gameId = gameId
    if (this.status.phase !== "playing") this.setStatus("starting", "Connexion à la partie…")
    const ws = new WebSocket(account.socketUrl(`/ws/${gameId}`))
    this.ws = ws
    ws.addEventListener("message", (e) => {
      try {
        const msg = JSON.parse(String(e.data))
        this.onMessage(msg.type, msg.payload ?? {})
      } catch (err) {
        console.error("[officiel] message illisible :", err)
      }
    })
    ws.addEventListener("close", (e) => this.onClose(ws, e.code))
  }

  private async onClose(ws: WebSocket, code: number) {
    if (this.ws !== ws || this.closed || this.state?.over) return
    if (code === 4001 && !this.refreshedForSocket) {
      // Not authenticated: refresh the session once, then reconnect
      this.refreshedForSocket = true
      try {
        await account.api("/me")
      } catch (e) {
        return this.fail(e)
      }
    } else if (TERMINAL_CLOSE.includes(code)) {
      return this.fail(new OfficialError(`Le serveur officiel a fermé la connexion (code ${code}).`))
    }
    this.reconnect = window.setTimeout(() => this.gameId && this.connect(this.gameId), 2000)
  }

  private send(type: string, payload: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type, payload }))
  }

  private onMessage(type: string, payload: any) {
    switch (type) {
      case "game_state":
        this.refreshedForSocket = false
        if (payload.your_player) this.seat = (payload.your_player - 1) as Seat
        this.state = this.translate(payload)
        this.setStatus(this.state.over ? "over" : "playing", this.state.over ? this.state.reason : "Partie en cours")
        break
      case "waiting_for_opponent":
        this.setStatus("waiting", "Partie créée. Envoie ce lien à ton ami, la partie commence dès qu'il le rejoint :", `${SITE}/join/${this.gameId}`)
        break
      case "opponent_joined":
        this.onNotice("Adversaire trouvé !")
        break
      case "game_over":
      case "game_aborted":
        if (this.state) {
          const winner = type === "game_aborted" ? null : payload.winner
          this.state = { ...this.state, over: true, winner: winner === 1 ? 0 : winner === 2 ? 1 : null, score: payload.scores ?? this.state.score }
          this.state.reason = describeEnd(payload.reason ?? (type === "game_aborted" ? "no_show" : ""), payload.victory_type)
        }
        this.setStatus("over", REASONS[payload.reason] ?? "Partie terminée")
        break
      case "draw_offer":
        this.status = { ...this.status, drawOffer: payload.from_username ?? "L'adversaire" }
        this.onChange()
        break
      case "draw_declined":
        this.onNotice(`${payload.by_username ?? "L'adversaire"} a refusé la nulle.`)
        break
      case "spectator":
        this.fail(new OfficialError("Le serveur officiel te considère comme spectateur de cette partie."))
        break
      case "error":
        this.onNotice(payload.message ?? "Erreur du serveur officiel.")
        if (payload.fatal) this.ws?.close()
        break
      case "player_disconnected":
        this.onNotice("L'adversaire s'est déconnecté.")
        break
    }
  }

  // ---------------------------------------------------------------- translation

  private translate(p: any): GameState {
    const officialPieces: OfficialPiece[] = p.pieces ?? []
    if (!this.ids.length) this.ids = officialPieces.map((piece) => piece.id).sort()
    const index = new Map(this.ids.map((id, i) => [id, i]))
    const heights = new Array<number>(N * N).fill(0)
    ;(p.board as number[][]).forEach((row, r) => row.forEach((h, c) => (heights[toCell(r, c)] = h)))
    const pieces: Piece[] = officialPieces
      .map((piece) => ({
        id: index.get(piece.id)!,
        owner: (piece.player - 1) as Seat,
        type: piece.type,
        cell: toCell(piece.row, piece.col),
        status: piece.is_captured ? ("captured" as const) : piece.is_finished ? ("finished" as const) : ("board" as const),
      }))
      .sort((a, b) => a.id - b.id)
    const winner = p.winner === 1 ? 0 : p.winner === 2 ? 1 : null
    const base: GameState = {
      mode: "balanced",
      heights,
      pieces,
      turn: (p.current_turn - 1) as Seat,
      ply: p.move_count ?? 0,
      score: p.scores ?? [0, 0],
      finished: (p.finished_pieces ?? []).map((id: string) => index.get(id)!),
      over: !!p.game_over,
      winner: p.game_over ? winner : null,
      reason: p.game_over ? describeEnd(p.result_reason ?? p.draw_reason ?? "", p.victory_type) : "",
      last: null,
    }

    // Legal actions come from the official server; our engine only adds paths and attack odds for display
    this.sourceMoves.clear()
    const moves: Record<number, LegalAction[]> = {}
    const scope: Record<number, LegalAction[]> = {}
    const lists: [Record<string, ValidMove[]> | undefined, boolean][] = [
      [p.valid_moves, true],
      [p.opponent_valid_moves, false],
    ]
    for (const [list, current] of lists) {
      for (const [officialId, valid] of Object.entries(list ?? {})) {
        const id = index.get(officialId)
        if (id === undefined) continue
        const ours = pieceScope(base, id)
        const actions = valid.map((move) => {
          const legal = toLegal(pieces[id], move, ours)
          if (current) this.sourceMoves.set(actionKey(legal.action), move)
          return legal
        })
        if (current) moves[id] = actions
        scope[id] = actions
      }
    }

    const previous = this.state
    const record: MoveRecord | undefined = p.move_record ?? p.move_history?.at(-1)
    if (previous && record && base.ply === previous.ply + 1) base.last = lastMove(previous, base, record, index)

    const clocks: [number, number] | null =
      p.time_control && p.player1_time_remaining_ms != null && p.player2_time_remaining_ms != null
        ? [p.player1_time_remaining_ms, p.player2_time_remaining_ms]
        : null
    base.official = {
      gameId: this.gameId ?? "",
      terrain: p.terrain_selected ?? p.terrain ?? "",
      usernames: [p.player1_username ?? "Joueur 1", p.player2_username ?? "Joueur 2"],
      moves,
      scope,
      clocks,
      clockStartedAt: p.clock_started_at_epoch_ms ?? null,
      serverTime: p.server_time_epoch_ms ?? Date.now(),
    }
    return base
  }

  private setStatus(phase: OfficialStatus["phase"], message: string, link?: string) {
    this.status = { phase, message, link, drawOffer: this.status.drawOffer }
    this.onChange()
  }

  private fail(e: unknown) {
    this.closed = true
    this.stopPolling()
    this.ws?.close()
    const message = e instanceof OfficialError ? e.message : `Erreur de connexion au site officiel : ${(e as Error)?.message ?? e}`
    console.error("[officiel]", message)
    this.setStatus("error", message)
    if (e instanceof OfficialError && e.login) {
      this.status.login = true
      this.onChange()
    }
  }

  private stopPolling() {
    clearInterval(this.poll)
    this.poll = 0
  }
}

const actionKey = (a: Action) => `${a.pieceId}:${a.kind}:${a.kind === "exit" ? a.from : a.to}`

/** An official move as one of our legal actions, borrowing our engine's path and attack odds when it agrees */
function toLegal(piece: Piece, move: ValidMove, ours: LegalAction[]): LegalAction {
  const pieceId = piece.id
  if (move.can_finish || offBoard(move.to_row)) {
    const from = cellAt(move.to_col, goalRow(piece.owner))
    const match = ours.find((la) => la.action.kind === "exit" && la.action.from === from)
    return { action: { kind: "exit", pieceId, from }, path: match?.path ?? [piece.cell, from], cost: move.cost }
  }
  const to = toCell(move.to_row, move.to_col)
  const kind = move.is_attack ? "attack" : "move"
  const match = ours.find((la) => la.action.kind === kind && la.action.to === to)
  const special = !match || (match.action.kind !== "exit" && match.action.special)
  return { action: { kind, pieceId, to, special }, path: match?.path ?? [piece.cell, to], cost: move.cost, attack: match?.attack }
}

/** Rebuilds the last move for the client's animation */
function lastMove(previous: GameState, next: GameState, record: MoveRecord, index: Map<string, number>): GameState["last"] {
  const pieceId = index.get(record.pieceId)
  if (pieceId === undefined) return null
  const owner = next.pieces[pieceId].owner
  const captured = next.pieces.find((p) => p.status === "captured" && previous.pieces[p.id]?.status === "board")?.id ?? null
  let action: Action
  if (offBoard(record.toRow)) action = { kind: "exit", pieceId, from: cellAt(record.toCol, goalRow(owner)) }
  else action = { kind: captured !== null ? "attack" : "move", pieceId, to: toCell(record.toRow, record.toCol), special: false }
  const from = toCell(record.fromRow, record.fromCol)
  const target = action.kind === "exit" ? action.from : action.to
  // The official state only lists the moves of the side to play: for the other side, find a likely path ourselves.
  // It may not be the one actually taken, it only has to look right in the animation
  const key = actionKey(action)
  const official = previous.official
  const known = [official?.moves[pieceId], official?.scope[pieceId], pieceScope({ ...previous, official: undefined }, pieceId)]
    .map((list) => list?.find((la) => actionKey(la.action) === key && la.path[0] === from))
    .find(Boolean)
  return { action, path: known?.path ?? walkPath(previous, from, target), captured }
}

/** Shortest walk between two squares, around the other pieces (the last resort for the animation) */
function walkPath(state: GameState, from: number, to: number): number[] {
  const blocked = new Set(state.pieces.filter((p) => p.status === "board").map((p) => p.cell))
  const cameFrom = new Map<number, number>([[from, from]])
  const queue = [from]
  while (queue.length) {
    const cell = queue.shift()!
    if (cell === to) break
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = cellX(cell) + dx,
        y = cellY(cell) + dy
      if (!inBoard(x, y)) continue
      const next = cellAt(x, y)
      if (cameFrom.has(next) || (blocked.has(next) && next !== to)) continue
      cameFrom.set(next, cell)
      queue.push(next)
    }
  }
  if (!cameFrom.has(to)) return [from, to]
  const path = [to]
  while (path[0] !== from) path.unshift(cameFrom.get(path[0])!)
  return path
}

function describeEnd(reason: string, victory?: string | null) {
  const text = REASONS[reason] ?? "Fin de partie"
  return victory && VICTORIES[victory] ? `${text} — ${VICTORIES[victory]}` : text
}
