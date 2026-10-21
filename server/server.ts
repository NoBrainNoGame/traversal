import { createServer } from "node:http"
import { readFile, stat } from "node:fs/promises"
import { networkInterfaces } from "node:os"
import { extname, join, normalize } from "node:path"
import { randomUUID } from "node:crypto"
import { WebSocketServer, WebSocket } from "ws"
import { applyAction, newGame, TERRAIN_MODES, type GameState, type Seat, type TerrainMode } from "../shared/rules"
import type { ClientMessage, ServerMessage } from "../shared/protocol"
import { OfficialGame } from "./official"

const PORT = Number(process.env.PORT ?? 3000)
const DIST = join(import.meta.dirname, "..", "dist")

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
}

const http = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost")
  const path = normalize(join(DIST, decodeURIComponent(url.pathname)))
  if (!path.startsWith(DIST)) {
    res.writeHead(403).end()
    return
  }
  try {
    const file = (await stat(path)).isDirectory() ? join(path, "index.html") : path
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" })
    res.end(await readFile(file))
  } catch {
    res.writeHead(404).end("Not found")
  }
})

function lanUrls() {
  const urls: string[] = []
  for (const [name, list] of Object.entries(networkInterfaces())) {
    // Virtual bridges (Docker, VMs) aren't reachable by a friend on the network
    if (/^(docker|br-|veth|virbr|vmnet|vboxnet)/.test(name)) continue
    for (const net of list ?? []) {
      if (net.family === "IPv4" && !net.internal) urls.push(`http://${net.address}:${PORT}`)
    }
  }
  return urls
}

// ------------------------------------------------------------------ single room

const seats: [string | null, string | null] = [null, null]
const sockets = new Map<WebSocket, Seat | null>()
let mode: TerrainMode = "balanced"
let game: GameState | null = null
/** A game on traversalgame.com; while it exists, every client shows it instead of the local game */
let official: OfficialGame | null = null

const connected = (): [boolean, boolean] => [0, 1].map((s) => [...sockets.values()].includes(s as Seat)) as [boolean, boolean]

function send(ws: WebSocket, msg: ServerMessage) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

function broadcast() {
  for (const ws of sockets.keys()) {
    if (official) {
      send(ws, { t: "official", status: official.status, seat: official.seat })
      if (official.state) send(ws, { t: "state", state: official.state, connected: [true, true] })
    } else if (game) send(ws, { t: "state", state: game, connected: connected() })
    else send(ws, { t: "lobby", connected: connected(), mode })
  }
}

function notice(message: string) {
  for (const ws of sockets.keys()) send(ws, { t: "error", message })
}

async function leaveOfficial() {
  const leaving = official
  official = null
  // Back to the local game: everyone gets their own seat again
  for (const [ws, seat] of sockets) send(ws, { t: "official", status: null, seat })
  broadcast()
  await leaving?.leave()
}

function claimSeat(token?: string): { seat: Seat | null; token: string } {
  const known = seats.indexOf(token ?? null)
  if (token && known >= 0) return { seat: known as Seat, token }
  const fresh = randomUUID()
  const free = seats.indexOf(null)
  if (free < 0) return { seat: null, token: fresh }
  seats[free] = fresh
  return { seat: free as Seat, token: fresh }
}

const wss = new WebSocketServer({ server: http, path: "/ws" })

wss.on("connection", (ws) => {
  sockets.set(ws, null)

  ws.on("message", (data) => {
    let msg: ClientMessage
    try {
      msg = JSON.parse(String(data))
    } catch {
      return
    }
    const seat = sockets.get(ws) ?? null

    if (msg.t === "hello") {
      const claim = claimSeat(msg.token)
      sockets.set(ws, claim.seat)
      send(ws, { t: "welcome", seat: claim.seat, token: claim.token, urls: lanUrls() })
      if (official) return broadcast()
      if (!game && seats[0] && seats[1]) game = newGame(mode)
      broadcast()
    } else if (msg.t === "action") {
      if (official) {
        const error = seat === null ? "Tu regardes la partie." : official.play(msg.action)
        if (error) send(ws, { t: "error", message: error })
        return
      }
      if (!game || seat === null || game.turn !== seat) return send(ws, { t: "error", message: "Ce n'est pas ton tour." })
      if (game.pieces[msg.action?.pieceId]?.owner !== seat) return send(ws, { t: "error", message: "Pièce invalide." })
      const next = applyAction(game, msg.action)
      if (!next) return send(ws, { t: "error", message: "Coup illégal." })
      game = next
      broadcast()
    } else if (msg.t === "newGame") {
      if (seat === null || !(msg.mode in TERRAIN_MODES)) return
      // The terrain can be changed before the game starts or once it is over
      if (game && !game.over) return
      mode = msg.mode
      if (game) game = newGame(mode)
      broadcast()
    } else if (seat === null) {
      // Spectators can't start or steer official games
    } else if (msg.t === "official") {
      if (official) return
      official = new OfficialGame(broadcast, notice)
      broadcast()
      void official.start(msg.kind)
    } else if (msg.t === "officialLeave") {
      void leaveOfficial()
    } else if (msg.t === "officialGhost") {
      void official?.answerGhost(msg.accept)
    } else if (msg.t === "officialDraw") {
      official?.answerDraw(msg.accept)
    }
  })

  ws.on("close", () => {
    sockets.delete(ws)
    broadcast()
  })
})

http.listen(PORT, "0.0.0.0", () => {
  console.log(`\nTraversal est lancé !\n`)
  console.log(`  Toi :       http://localhost:${PORT}`)
  for (const url of lanUrls()) console.log(`  Ton ami :   ${url}`)
  console.log(`\n(Ctrl+C pour arrêter)\n`)
})
