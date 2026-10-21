import "./prototypes"
import { Functional, Parallel, Runner } from "@ghom/booyah"
import type { ServerMessage } from "../shared/protocol"
import type { GameState } from "../shared/rules"
import { Board3D } from "./board3d"
import { makeAppMachine, Session } from "./flow"
import { Hud } from "./hud"
import { Net } from "./net"

const boardCanvas = document.getElementById("board") as HTMLCanvasElement
const hudCanvas = document.getElementById("hud") as HTMLCanvasElement

const hud = new Hud()
await hud.init(hudCanvas)

// The HUD canvas sits on top and receives the pointer; the board reads the same events
// unless they land on a HUD panel or button
const board = new Board3D(boardCanvas, hudCanvas, (x, y) => hud.isOverHud(x, y))

const resize = () => board.resize(innerWidth, innerHeight)
addEventListener("resize", resize)
resize()

const session = new Session()
const net = new Net()
const teamLabel = (seat: 0 | 1) => (seat === 0 ? "Rouge" : "Bleu")

net.addEventListener("open", () => session.set({ online: true }))
net.addEventListener("close", () => session.set({ online: false }))
net.addEventListener("welcome", (e) => {
  const msg = (e as CustomEvent<Extract<ServerMessage, { t: "welcome" }>>).detail
  board.setSeatView(msg.seat ?? 0)
  session.set({ seat: msg.seat, urls: msg.urls })
})
net.addEventListener("official", (e) => {
  const msg = (e as CustomEvent<Extract<ServerMessage, { t: "official" }>>).detail
  if (msg.seat !== session.seat) board.setSeatView(msg.seat ?? 0)
  session.set({ official: msg.status, seat: msg.seat })
})
net.addEventListener("lobby", (e) => {
  const msg = (e as CustomEvent<Extract<ServerMessage, { t: "lobby" }>>).detail
  session.set({ state: null, connected: msg.connected, lobbyMode: msg.mode })
})
net.addEventListener("state", (e) => {
  const msg = (e as CustomEvent<Extract<ServerMessage, { t: "state" }>>).detail
  const prev: GameState | null = session.state
  const animate = !!prev && prev.heights.join() === msg.state.heights.join() && msg.state.ply === prev.ply + 1
  board.setState(msg.state, animate)
  session.set({ state: msg.state, connected: msg.connected, stateReceivedAt: Date.now() })
})
net.addEventListener("error", (e) => hud.toast((e as CustomEvent).detail.message))

const clock = (ms: number) => {
  const total = Math.ceil(Math.max(ms, 0) / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`
}

/** Official games: each player's name and remaining time, the side to move's clock running */
function officialPlayers(state: GameState, receivedAt: number) {
  const info = state.official!
  const times = info.clocks ? [...info.clocks] : null
  if (times && info.clockStartedAt !== null && !state.over) {
    const serverNow = Date.now() - (receivedAt - info.serverTime)
    times[state.turn] -= serverNow - info.clockStartedAt
  }
  return ([0, 1] as const).map((seat) => `${seat === state.turn && !state.over ? "▶ " : ""}${info.usernames[seat]}${times ? " " + clock(times[seat]) : ""}`)
}

// Top bar: who I am, the score and the move count
function updateBar() {
  const { seat, state, connected } = session
  const status = seat === null ? [{ color: 0x888888, label: "Spectateur" }] : [{ color: seat === 0 ? 0xd8443a : 0x3a7bd8, label: `Tu es ${teamLabel(seat)}` }]
  const right: string[] = []
  if (state?.official) right.push(officialPlayers(state, session.stateReceivedAt).join("  vs  "))
  if (state) right.push(`Rouge ${state.score[0]} – ${state.score[1]} Bleu`, `Coup ${state.ply + 1}`)
  if (seat !== null && state && !connected[1 - seat]) right.push("⚠ adversaire déconnecté")
  hud.update({ status, right })
}
session.addEventListener("change", updateBar)
setInterval(() => session.state?.official && updateBar(), 250)

net.connect()

new Runner(
  new Parallel([
    new Functional({ tick: () => board.render() }),
    makeAppMachine(),
  ]),
  { rootContext: { net, board, hud, session } },
).start()
