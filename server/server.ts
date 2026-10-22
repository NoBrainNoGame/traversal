import { createServer } from "node:http"
import { createServer as createSecureServer } from "node:https"
import { readFile, stat } from "node:fs/promises"
import { networkInterfaces } from "node:os"
import { extname, join, normalize } from "node:path"
import { randomUUID } from "node:crypto"
import { generate } from "selfsigned"
import { WebSocketServer, WebSocket } from "ws"
import { applyAction, newGame, TERRAIN_MODES, type GameState, type Seat, type TerrainMode } from "../shared/rules"
import type { ChatMessage, ClientMessage, ServerMessage } from "../shared/protocol"

const PORT = Number(process.env.PORT ?? 3000)
/** Browsers only give the camera to secure pages: a friend on the network uses this https port for the webcam */
const SECURE_PORT = PORT + 1
const DIST = join(import.meta.dirname, "..", "dist")

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
}

async function serveFile(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) {
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
}

function lanAddresses() {
  const addresses: string[] = []
  for (const [name, list] of Object.entries(networkInterfaces())) {
    // Virtual bridges (Docker, VMs) aren't reachable by a friend on the network
    if (/^(docker|br-|veth|virbr|vmnet|vboxnet)/.test(name)) continue
    for (const net of list ?? []) {
      if (net.family === "IPv4" && !net.internal) addresses.push(net.address)
    }
  }
  return addresses
}

const lanUrls = () => lanAddresses().map((ip) => `http://${ip}:${PORT}`)
const secureUrls = () => lanAddresses().map((ip) => `https://${ip}:${SECURE_PORT}`)

const http = createServer(serveFile)
// Self-signed for localhost and the LAN addresses: the friend accepts the browser warning once
const certificate = await generate([{ name: "commonName", value: "traversal.local" }], {
  keySize: 2048,
  extensions: [{ name: "subjectAltName", altNames: [{ type: 2, value: "localhost" }, ...["127.0.0.1", ...lanAddresses()].map((ip) => ({ type: 7 as const, ip }))] }],
})
const https = createSecureServer({ key: certificate.private, cert: certificate.cert }, serveFile)

// ------------------------------------------------------------------ single room

const seats: [string | null, string | null] = [null, null]
const sockets = new Map<WebSocket, Seat | null>()
let mode: TerrainMode = "balanced"
let game: GameState | null = null
const chat: ChatMessage[] = []
const CHAT_HISTORY = 60
const TEAMS = ["Rouge", "Bleu"]

const connected = (): [boolean, boolean] => [0, 1].map((s) => [...sockets.values()].includes(s as Seat)) as [boolean, boolean]

function send(ws: WebSocket, msg: ServerMessage) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

function broadcast() {
  for (const ws of sockets.keys()) {
    if (game) send(ws, { t: "state", state: game, connected: connected() })
    else send(ws, { t: "lobby", connected: connected(), mode })
  }
}

function notice(message: string) {
  for (const ws of sockets.keys()) send(ws, { t: "error", message })
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

/** The players trade colours: each keeps its connection, its token now holds the other seat */
function swapSeats() {
  seats.reverse()
  for (const [ws, seat] of sockets) {
    if (seat === null) continue
    const swapped = (1 - seat) as Seat
    sockets.set(ws, swapped)
    send(ws, { t: "welcome", seat: swapped, token: seats[swapped]!, urls: lanUrls(), secureUrls: secureUrls() })
  }
  broadcast()
}

function say(seat: Seat | null, text: string) {
  const message: ChatMessage = {
    from: seat === null ? "Spectateur" : TEAMS[seat],
    color: seat === null ? "#9aa0ab" : seat === 0 ? "#ff6b5e" : "#5e9bff",
    text: text.slice(0, 300),
  }
  chat.push(message)
  chat.splice(0, chat.length - CHAT_HISTORY)
  for (const ws of sockets.keys()) send(ws, { t: "chat", messages: [message] })
}

function onConnection(ws: WebSocket) {
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
      send(ws, { t: "welcome", seat: claim.seat, token: claim.token, urls: lanUrls(), secureUrls: secureUrls() })
      send(ws, { t: "chat", messages: chat, reset: true })
      if (!game && seats[0] && seats[1]) game = newGame(mode)
      broadcast()
    } else if (msg.t === "action") {
      if (!game || seat === null || game.turn !== seat) return send(ws, { t: "error", message: "Ce n'est pas ton tour." })
      if (game.pieces[msg.action?.pieceId]?.owner !== seat) return send(ws, { t: "error", message: "Pièce invalide." })
      const next = applyAction(game, msg.action)
      if (!next) return send(ws, { t: "error", message: "Coup illégal." })
      game = next
      broadcast()
    } else if (msg.t === "chat") {
      if (typeof msg.text === "string" && msg.text.trim()) say(seat, msg.text.trim())
    } else if (msg.t === "rtc") {
      // Webcams link the two players directly; the host only passes the signalling along
      if (seat === null) return
      for (const [other, otherSeat] of sockets) if (otherSeat !== null && otherSeat !== seat) send(other, { t: "rtc", signal: msg.signal })
    } else if (seat === null) {
      // Spectators can't restart or steer games
    } else if (msg.t === "newGame") {
      if (!(msg.mode in TERRAIN_MODES)) return
      const restarted = !!game && !game.over
      mode = msg.mode
      // Before both players are there, this only picks the terrain
      if (game) game = newGame(mode)
      broadcast()
      if (restarted) notice(`${TEAMS[seat]} a relancé la partie.`)
    } else if (msg.t === "swapSeats") {
      swapSeats()
      notice("Les camps ont été échangés.")
    }
  })

  ws.on("close", () => {
    const seat = sockets.get(ws)
    sockets.delete(ws)
    // The other player's webcam link to this page is gone
    if (seat !== null && seat !== undefined) for (const [other, otherSeat] of sockets) if (otherSeat === 1 - seat) send(other, { t: "rtc", signal: { kind: "bye" } })
    broadcast()
  })
}

for (const server of [http, https]) new WebSocketServer({ server, path: "/ws" }).on("connection", onConnection)

http.listen(PORT, "0.0.0.0", () => {
  console.log(`\nTraversal est lancé !\n`)
  console.log(`  Toi :       http://localhost:${PORT}`)
  for (const url of lanUrls()) console.log(`  Ton ami :   ${url}`)
})
https.listen(SECURE_PORT, "0.0.0.0", () => {
  for (const url of secureUrls()) console.log(`  Avec webcam : ${url}  (certificat auto-signé : accepter l'avertissement)`)
  console.log(`\n(Ctrl+C pour arrêter)\n`)
})
