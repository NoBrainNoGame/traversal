// Plays games on traversalgame.com (with its developer's permission) through the user's Firefox session.
// The official server stays authoritative: its states are translated into ours for the 3D client, our actions
// into its moves. Protocol notes: REST on api.traversalgame.com, one WebSocket per game, JSON {type, payload}.

import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { WebSocket } from "ws"
import { cellAt, goalRow, N, pieceScope, type Action, type GameState, type LegalAction, type Piece, type PieceType, type Seat } from "../shared/rules"
import type { OfficialKind, OfficialStatus } from "../shared/protocol"

const API = "https://api.traversalgame.com"
const SITE = "https://www.traversalgame.com"
const USER_AGENT = "TraversalNoBrainNoGameClient/1.0 (unofficial client, https://github.com/NoBrainNoGame/traversal)"
const BOT_DIFFICULTY = 5
const TIME_CONTROL = "10+0"
const FIREFOX_DIRS = [".mozilla/firefox", "snap/firefox/common/.mozilla/firefox", ".var/app/org.mozilla.firefox/.mozilla/firefox"]
/** Close codes after which the official web client gives up instead of reconnecting */
const TERMINAL_CLOSE = [4001, 4003, 4004, 4008]

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

class OfficialError extends Error {}

// ------------------------------------------------------------------ session cookies

/** The traversalgame.com cookies of the most recently used Firefox session (outside containers) */
function firefoxCookies() {
  const latest = new Map<string, { value: string; at: number }>()
  for (const dir of FIREFOX_DIRS) {
    const root = join(homedir(), dir)
    if (!existsSync(root)) continue
    for (const profile of readdirSync(root)) {
      const db = join(root, profile, "cookies.sqlite")
      if (!existsSync(db)) continue
      // Firefox keeps the database locked and its latest writes in the WAL file: read a copy of both
      const tmp = mkdtempSync(join(tmpdir(), "traversal-cookies-"))
      try {
        copyFileSync(db, join(tmp, "cookies.sqlite"))
        if (existsSync(db + "-wal")) copyFileSync(db + "-wal", join(tmp, "cookies.sqlite-wal"))
        const sql = new DatabaseSync(join(tmp, "cookies.sqlite"))
        const rows = sql
          .prepare("SELECT name, value, lastAccessed FROM moz_cookies WHERE host LIKE '%traversalgame.com' AND originAttributes = ''")
          .all() as { name: string; value: string; lastAccessed: number }[]
        sql.close()
        for (const row of rows) {
          const at = Number(row.lastAccessed)
          if ((latest.get(row.name)?.at ?? -1) < at) latest.set(row.name, { value: row.value, at })
        }
      } catch {
        // An unreadable profile is skipped
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    }
  }
  return new Map([...latest].map(([name, { value }]) => [name, value]))
}

/** Cookies sent to the API, kept up to date from Firefox and from the API's own Set-Cookie headers */
class Jar {
  private cookies = new Map<string, string>()

  loadFromFirefox() {
    const fresh = firefoxCookies()
    if (fresh.size) this.cookies = fresh
    return fresh.size > 0
  }

  /** Like the browser: the refresh cookie only goes to the refresh route */
  header(path: string) {
    return [...this.cookies]
      .filter(([name]) => name !== "traversal_refresh" || path.startsWith("/auth/refresh"))
      .map(([name, value]) => `${name}=${value}`)
      .join("; ")
  }

  absorb(res: Response) {
    for (const line of res.headers.getSetCookie()) {
      const pair = line.split(";")[0]
      const eq = pair.indexOf("=")
      const name = pair.slice(0, eq).trim(),
        value = pair.slice(eq + 1).trim()
      if (!value || /max-age=0\b/i.test(line)) this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
  }
}

const jar = new Jar()

const headers = (path: string) => ({ cookie: jar.header(path), origin: SITE, referer: SITE + "/", "user-agent": USER_AGENT })

function errorMessage(data: any, fallback: string): string {
  const detail = data?.detail
  if (typeof detail === "string") return detail
  if (typeof detail?.message === "string") return detail.message
  if (typeof data?.message === "string") return data.message
  if (typeof data?.code === "string") return data.code
  return fallback
}

/** Calls the API; on 401, first rereads Firefox's cookies (the site may have refreshed them), then refreshes the session itself */
async function api(path: string, method = "GET", body?: unknown) {
  const call = async () => {
    const res = await fetch(API + path, {
      method,
      headers: { ...headers(path), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    jar.absorb(res)
    return res
  }
  let res = await call()
  if (res.status === 401 && jar.loadFromFirefox()) res = await call()
  if (res.status === 401) {
    const refresh = await fetch(API + "/auth/refresh", { method: "POST", headers: headers("/auth/refresh") })
    jar.absorb(refresh)
    if (refresh.ok) res = await call()
  }
  if (res.status === 401) throw new OfficialError("Session expirée : reconnecte-toi sur traversalgame.com dans Firefox, puis réessaie.")
  const text = await res.text()
  let data: any = null
  try {
    data = JSON.parse(text)
  } catch {}
  return { status: res.status, ok: res.ok, data }
}

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
  private poll: NodeJS.Timeout | null = null
  private reconnect: NodeJS.Timeout | null = null
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
      if (!jar.loadFromFirefox()) throw new OfficialError("Aucune session traversalgame.com trouvée dans Firefox : connecte-toi sur le site avec Firefox.")
      const me = await api("/me")
      if (!me.ok) throw new OfficialError(errorMessage(me.data, "Impossible de lire ton compte traversalgame.com."))
      const name = me.data?.username ?? "toi"
      if (kind === "bot") {
        this.setStatus("starting", `Connecté en tant que ${name}. Création d'une partie contre un bot (niveau ${BOT_DIFFICULTY})…`)
        const res = await api("/api/games/vs-bot", "POST", { terrain: "random", difficulty: BOT_DIFFICULTY, player_side: null, time_control: TIME_CONTROL })
        this.openGame(res, "Impossible de créer la partie contre le bot.")
      } else if (kind === "friend") {
        this.setStatus("starting", `Connecté en tant que ${name}. Création d'une partie privée…`)
        const res = await api("/api/games", "POST", { terrain: "random", play_as: "random", private: true, ranked: false })
        this.openGame(res, "Impossible de créer la partie privée.")
      } else {
        this.setStatus("searching", `Connecté en tant que ${name}. Recherche d'un adversaire…`)
        const res = await api("/api/games/find", "POST", { terrain: "random", ranked: false })
        if (this.resumeActive(res)) return
        if (!res.ok) throw new OfficialError(errorMessage(res.data, "Impossible de lancer la recherche."))
        this.onFindStatus(res.data)
        if (!this.gameId) this.poll = setInterval(() => this.checkFind(), 2000)
      }
    } catch (e) {
      this.fail(e)
    }
  }

  /** A 409 means a game is already going on for this account: play that one */
  private resumeActive(res: { status: number; data: any }) {
    const id = res.status === 409 ? res.data?.detail?.game_id : null
    if (!id) return false
    this.onNotice("Tu as déjà une partie en cours sur le site : reprise de cette partie.")
    this.connect(id)
    return true
  }

  private openGame(res: { ok: boolean; status: number; data: any }, fallback: string) {
    if (this.resumeActive(res)) return
    if (!res.ok || !res.data?.game_id) throw new OfficialError(errorMessage(res.data, fallback))
    this.connect(res.data.game_id)
  }

  private async checkFind() {
    if (this.closed) return
    try {
      const res = await api("/api/games/find/status")
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
        await api("/api/games/find/decline-bot", "POST")
        this.setStatus("searching", "Recherche d'un adversaire…")
        return
      }
      const res = await api("/api/games/find/accept-bot", "POST")
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
    if (this.reconnect) clearTimeout(this.reconnect)
    this.ws?.close()
    try {
      if (phase === "searching" || phase === "ghost") await api("/api/games/find", "DELETE")
      if (phase === "waiting" && this.gameId) await api(`/api/games/${this.gameId}/cancel`, "POST")
    } catch {}
  }

  // ---------------------------------------------------------------- game socket

  private connect(gameId: string) {
    if (this.closed) return
    this.gameId = gameId
    if (this.status.phase !== "playing") this.setStatus("starting", "Connexion à la partie…")
    const path = `/ws/${gameId}`
    const ws = new WebSocket(API.replace("https", "wss") + path, { headers: headers(path) })
    this.ws = ws
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(String(data))
        this.onMessage(msg.type, msg.payload ?? {})
      } catch (e) {
        console.error("[officiel] message illisible :", e)
      }
    })
    ws.on("close", (code) => this.onClose(ws, code))
    ws.on("error", (e) => console.error("[officiel] erreur WebSocket :", e.message))
  }

  private async onClose(ws: WebSocket, code: number) {
    if (this.ws !== ws || this.closed || this.state?.over) return
    if (code === 4001 && !this.refreshedForSocket) {
      // Not authenticated: refresh the session once, then reconnect
      this.refreshedForSocket = true
      try {
        await api("/me")
      } catch (e) {
        return this.fail(e)
      }
    } else if (TERMINAL_CLOSE.includes(code)) {
      return this.fail(new OfficialError(`Le serveur officiel a fermé la connexion (code ${code}).`))
    }
    this.reconnect = setTimeout(() => this.gameId && this.connect(this.gameId), 2000)
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
  }

  private stopPolling() {
    if (this.poll) clearInterval(this.poll)
    this.poll = null
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
  const known = previous.official?.moves[pieceId]?.find((la) => actionKey(la.action) === actionKey(action))
  const from = toCell(record.fromRow, record.fromCol)
  const target = action.kind === "exit" ? action.from : action.to
  return { action, path: known?.path ?? [from, target], captured }
}

function describeEnd(reason: string, victory?: string | null) {
  const text = REASONS[reason] ?? "Fin de partie"
  return victory && VICTORIES[victory] ? `${text} — ${VICTORIES[victory]}` : text
}
