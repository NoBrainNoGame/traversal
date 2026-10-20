// Traversal rules engine, shared by the server (authoritative) and the client (previews).
// Rules: https://www.traversalgame.com/rules

export const N = 10
export const MOVE_LIMIT = 200

export type PieceType = "explorer" | "vanguard" | "sentinel"
export type Seat = 0 | 1

export const PIECES: Record<PieceType, { move: number; strength: number; name: string; special: string }> = {
  explorer: {
    move: 5,
    strength: 1,
    name: "Explorateur",
    special: "Peut aussi faire 1 case en diagonale ou un saut de 2 cases, sans coût de hauteur.",
  },
  vanguard: {
    move: 4,
    strength: 2,
    name: "Avant-garde",
    special: "+1 en attaque s'il doit utiliser ses 4 points de mouvement pour atteindre la cible.",
  },
  sentinel: {
    move: 3,
    strength: 3,
    name: "Sentinelle",
    special: "Si c'est la toute première pièce à sortir du plateau, son camp gagne immédiatement.",
  },
}

export const TERRAIN_MODES = {
  balanced: "Équilibré",
  peaks: "Pics centraux",
  basins: "Bassins",
  mixed: "Montagnes & vallées",
  hills: "Collines douces",
  plains: "Plaines",
} as const
export type TerrainMode = keyof typeof TERRAIN_MODES

export interface Piece {
  id: number
  owner: Seat
  type: PieceType
  cell: number
  status: "board" | "captured" | "finished"
}

export type Action =
  | { kind: "move"; pieceId: number; to: number; special: boolean }
  | { kind: "attack"; pieceId: number; to: number; special: boolean }
  | { kind: "exit"; pieceId: number; from: number }

export interface LegalAction {
  action: Action
  /** Cells walked through, start included, destination included (for exits: the last board cell) */
  path: number[]
  cost: number
  attack?: { attack: number; defense: number }
}

export interface GameState {
  mode: TerrainMode
  heights: number[]
  pieces: Piece[]
  turn: Seat
  ply: number
  score: [number, number]
  /** Piece ids in finishing order */
  finished: number[]
  over: boolean
  winner: Seat | null
  reason: string
  last: { action: Action; path: number[]; captured: number | null } | null
}

export const cellX = (c: number) => c % N
export const cellY = (c: number) => Math.floor(c / N)
export const cellAt = (x: number, y: number) => y * N + x
export const inBoard = (x: number, y: number) => x >= 0 && y >= 0 && x < N && y < N
/** Player 0 starts on row 0 and exits past row 9, player 1 the other way around */
export const goalRow = (seat: Seat) => (seat === 0 ? N - 1 : 0)

const ORTHO = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
]
const DIAG = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
]

export function neighbors(c: number): number[] {
  const x = cellX(c),
    y = cellY(c)
  return ORTHO.filter(([dx, dy]) => inBoard(x + dx, y + dy)).map(([dx, dy]) => cellAt(x + dx, y + dy))
}

// ------------------------------------------------------------------ terrain

function mulberry32(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function valueNoise(rand: () => number, scale: number) {
  const G = 8
  const grid = Array.from({ length: G * G }, rand)
  const at = (i: number, j: number) => grid[(j % G) * G + (i % G)]
  const smooth = (t: number) => t * t * (3 - 2 * t)
  return (x: number, y: number) => {
    const fx = x / scale + 1,
      fy = y / scale + 1
    const x0 = Math.floor(fx),
      y0 = Math.floor(fy)
    const u = smooth(fx - x0),
      v = smooth(fy - y0)
    const top = at(x0, y0) * (1 - u) + at(x0 + 1, y0) * u
    const bottom = at(x0, y0 + 1) * (1 - u) + at(x0 + 1, y0 + 1) * u
    return top * (1 - v) + bottom * v
  }
}

/** Builds a fair (180° symmetric) board where neighbouring squares differ by at most 2 */
export function generateTerrain(mode: TerrainMode, seed = (Math.random() * 2 ** 32) >>> 0): number[] {
  const rand = mulberry32(seed)
  const coarse = valueNoise(rand, 3.5)
  const fine = valueNoise(rand, 1.6)
  const center = (x: number, y: number) => {
    const d = Math.hypot(x - 4.5, y - 4.5) / 6.4
    return Math.max(0, 1 - d)
  }

  const raw: number[] = []
  let maxHeight = 6
  for (let c = 0; c < N * N; c++) {
    const x = cellX(c),
      y = cellY(c)
    const a = coarse(x, y),
      b = fine(x, y)
    let v: number
    switch (mode) {
      case "peaks":
        maxHeight = 8
        v = Math.pow(center(x, y), 1.6) * 0.8 + a * 0.25
        break
      case "basins":
        maxHeight = 7
        v = 1 - Math.pow(1 - Math.abs(2 * a - 1), 2) * 0.8 + b * 0.15
        break
      case "mixed":
        maxHeight = 8
        v = Math.pow(a, 2) * 0.7 + Math.pow(b, 3) * 0.4
        break
      case "hills":
        maxHeight = 3
        v = a * 0.7 + b * 0.3
        break
      case "plains":
        maxHeight = 5
        v = b > 0.82 ? b : a * 0.15
        break
      default:
        maxHeight = 6
        v = a * 0.65 + b * 0.35
    }
    raw.push(v)
  }

  // 180° rotation symmetry: both players face the same landscape
  const sym = raw.map((v, c) => (v + raw[N * N - 1 - c]) / 2)
  const lo = Math.min(...sym),
    hi = Math.max(...sym)
  let h = sym.map((v) => Math.round(((v - lo) / (hi - lo || 1)) * maxHeight))

  // Lower every square until no cliff is higher than 2 (stays symmetric)
  let changed = true
  while (changed) {
    changed = false
    h = h.map((v, c) => {
      const cap = Math.min(...neighbors(c).map((n) => h[n] + 2))
      if (v > cap) {
        changed = true
        return cap
      }
      return v
    })
  }
  const min = Math.min(...h)
  return h.map((v) => v - min)
}

// ------------------------------------------------------------------ game

export function newGame(mode: TerrainMode = "balanced"): GameState {
  const order: PieceType[] = ["sentinel", "vanguard", "explorer", "explorer", "vanguard", "sentinel"]
  const pieces: Piece[] = []
  for (const owner of [0, 1] as Seat[]) {
    order.forEach((type, k) => {
      pieces.push({ id: pieces.length, owner, type, cell: cellAt(2 + k, owner === 0 ? 0 : N - 1), status: "board" })
    })
  }
  return {
    mode,
    heights: generateTerrain(mode),
    pieces,
    turn: 0,
    ply: 0,
    score: [0, 0],
    finished: [],
    over: false,
    winner: null,
    reason: "",
    last: null,
  }
}

export function pieceAt(state: GameState, cell: number): Piece | undefined {
  return state.pieces.find((p) => p.status === "board" && p.cell === cell)
}

export function moveCost(heights: number[], from: number, to: number) {
  return 1 + Math.abs(heights[from] - heights[to])
}

function attackStrength(state: GameState, attacker: Piece, target: Piece, vanguardCharge: boolean) {
  const h = state.heights
  let attack = PIECES[attacker.type].strength
  if (h[attacker.cell] > h[target.cell]) attack += 1
  if (h[attacker.cell] < h[target.cell]) attack -= 1
  if (vanguardCharge) attack += 1
  let defense = PIECES[target.type].strength
  for (const n of neighbors(target.cell)) {
    const p = pieceAt(state, n)
    if (!p || p.id === attacker.id) continue
    if (p.owner === attacker.owner) attack += PIECES[p.type].strength
    else defense += 1
  }
  return { attack, defense }
}

/** Every action the given piece can take right now (empty if it is not this piece's turn) */
export function legalActions(state: GameState, pieceId: number): LegalAction[] {
  const piece = state.pieces[pieceId]
  if (!piece || piece.status !== "board" || piece.owner !== state.turn || state.over) return []
  return pieceActions(state, piece, false)
}

/**
 * What a piece could do if it were its turn: every square it can reach, and every enemy in range,
 * including the ones too strong to capture (their `attack` tells the odds)
 */
export function pieceScope(state: GameState, pieceId: number): LegalAction[] {
  const piece = state.pieces[pieceId]
  if (!piece || piece.status !== "board") return []
  return pieceActions(state, piece, true)
}

function pieceActions(state: GameState, piece: Piece, withLostAttacks: boolean): LegalAction[] {
  const pieceId = piece.id
  const h = state.heights
  const budget = PIECES[piece.type].move
  const start = piece.cell

  // Dijkstra through empty squares
  const dist = new Array<number>(N * N).fill(Infinity)
  const prev = new Array<number>(N * N).fill(-1)
  const done = new Array<boolean>(N * N).fill(false)
  dist[start] = 0
  for (;;) {
    let u = -1
    for (let c = 0; c < N * N; c++) if (!done[c] && dist[c] <= budget && (u < 0 || dist[c] < dist[u])) u = c
    if (u < 0) break
    done[u] = true
    for (const v of neighbors(u)) {
      if (pieceAt(state, v)) continue
      const d = dist[u] + moveCost(h, u, v)
      if (d < dist[v]) {
        dist[v] = d
        prev[v] = u
      }
    }
  }
  const pathTo = (c: number) => {
    const path = [c]
    while (path[0] !== start) path.unshift(prev[path[0]])
    return path
  }

  const out: LegalAction[] = []
  const seen = new Set<string>()
  const push = (la: LegalAction) => {
    const key = la.action.kind + ":" + ("to" in la.action ? la.action.to : la.action.from)
    if (seen.has(key)) return
    seen.add(key)
    out.push(la)
  }

  for (let c = 0; c < N * N; c++) {
    if (c === start || dist[c] > budget) continue
    push({ action: { kind: "move", pieceId, to: c, special: false }, path: pathTo(c), cost: dist[c] })
  }

  for (const enemy of state.pieces) {
    if (enemy.status !== "board" || enemy.owner === piece.owner) continue
    let best = Infinity,
      from = -1
    for (const n of neighbors(enemy.cell)) {
      const d = dist[n] + moveCost(h, n, enemy.cell)
      if (d < best) {
        best = d
        from = n
      }
    }
    if (best > budget) continue
    const strength = attackStrength(state, piece, enemy, piece.type === "vanguard" && best === 4)
    if (strength.attack < strength.defense && !withLostAttacks) continue
    push({
      action: { kind: "attack", pieceId, to: enemy.cell, special: false },
      path: [...pathTo(from), enemy.cell],
      cost: best,
      attack: strength,
    })
  }

  const goal = goalRow(piece.owner)
  for (let x = 0; x < N; x++) {
    const c = cellAt(x, goal)
    if (dist[c] + 1 > budget) continue
    push({ action: { kind: "exit", pieceId, from: c }, path: pathTo(c), cost: dist[c] + 1 })
  }

  if (piece.type === "explorer") {
    const sx = cellX(start),
      sy = cellY(start)
    const jumps = [...DIAG, ...ORTHO.map(([dx, dy]) => [dx * 2, dy * 2])]
    for (const [dx, dy] of jumps) {
      if (!inBoard(sx + dx, sy + dy)) continue
      const c = cellAt(sx + dx, sy + dy)
      const other = pieceAt(state, c)
      if (!other) {
        push({ action: { kind: "move", pieceId, to: c, special: true }, path: [start, c], cost: budget })
      } else if (other.owner !== piece.owner) {
        const strength = attackStrength(state, piece, other, false)
        if (strength.attack < strength.defense && !withLostAttacks) continue
        push({ action: { kind: "attack", pieceId, to: c, special: true }, path: [start, c], cost: budget, attack: strength })
      }
    }
  }

  return out
}

export function allLegalActions(state: GameState): LegalAction[] {
  return state.pieces.flatMap((p) => legalActions(state, p.id))
}

export function sameAction(a: Action, b: Action) {
  if (a.kind !== b.kind || a.pieceId !== b.pieceId) return false
  if (a.kind === "exit" || b.kind === "exit") return a.kind === b.kind && (a as any).from === (b as any).from
  return a.to === b.to && a.special === b.special
}

/** Applies an action, returning a new state, or null if the action is illegal */
export function applyAction(state: GameState, action: Action): GameState | null {
  const legal = legalActions(state, action.pieceId).find((la) => sameAction(la.action, action))
  if (!legal) return null

  const next: GameState = structuredClone(state)
  const piece = next.pieces[action.pieceId]
  let captured: number | null = null

  if (action.kind === "move") {
    piece.cell = action.to
  } else if (action.kind === "attack") {
    const target = pieceAt(next, action.to)!
    target.status = "captured"
    captured = target.id
    piece.cell = action.to
  } else {
    piece.cell = action.from
    piece.status = "finished"
    next.finished.push(piece.id)
    next.score[piece.owner] += PIECES[piece.type].strength
    if (next.finished.length === 1 && piece.type === "sentinel") {
      endGame(next, piece.owner, "Une Sentinelle est sortie en premier")
    }
  }

  next.last = { action, path: legal.path, captured }
  next.ply++
  if (!next.over) checkEnd(next)
  if (!next.over) passTurn(next)
  return next
}

function passTurn(state: GameState) {
  state.turn = (1 - state.turn) as Seat
  // A player without any legal action skips their turn
  if (allLegalActions(state).length === 0) {
    state.turn = (1 - state.turn) as Seat
    if (allLegalActions(state).length === 0) endByScore(state, "Plus aucun coup possible")
  }
}

function endGame(state: GameState, winner: Seat | null, reason: string) {
  state.over = true
  state.winner = winner
  state.reason = reason
}

function endByScore(state: GameState, reason: string) {
  const [a, b] = state.score
  endGame(state, a === b ? null : a > b ? 0 : 1, reason)
}

function checkEnd(state: GameState) {
  if (state.finished.length >= 2) return endByScore(state, "Deux pièces sont sorties")
  if (state.ply < MOVE_LIMIT) return
  if (state.score[0] || state.score[1]) return endByScore(state, `Limite de ${MOVE_LIMIT} coups`)

  // Nobody scored: the piece closest to its exit wins, then the strongest one
  const best = ([0, 1] as Seat[]).map((seat) => {
    let rows = Infinity,
      strength = 0
    for (const p of state.pieces) {
      if (p.owner !== seat || p.status !== "board") continue
      const r = Math.abs(goalRow(seat) - cellY(p.cell))
      const s = PIECES[p.type].strength
      if (r < rows || (r === rows && s > strength)) {
        rows = r
        strength = s
      }
    }
    return { rows, strength }
  })
  const reason = `Limite de ${MOVE_LIMIT} coups (avancée)`
  if (best[0].rows !== best[1].rows) return endGame(state, best[0].rows < best[1].rows ? 0 : 1, reason)
  if (best[0].strength !== best[1].strength) return endGame(state, best[0].strength > best[1].strength ? 0 : 1, reason)
  endGame(state, null, reason)
}
