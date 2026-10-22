import "./prototypes"
import { Functional, Parallel, Runner } from "@ghom/booyah"
import type { ServerMessage } from "../shared/protocol"
import type { GameState } from "../shared/rules"
import { Board3D } from "./board3d"
import { Chat } from "./chat"
import { makeAppMachine, Session } from "./flow"
import { Host, STANDALONE, type HostMessage } from "./host"
import { Hud } from "./hud"
import { LoginForm } from "./login"
import { Net } from "./net"
import { PauseMenu } from "./pause"
import { account } from "./relay"
import { Webcam } from "./webcam"

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
const loginForm = new LoginForm()
// On GitHub Pages there's no local host: no local games, chat or webcams
const net = STANDALONE ? null : new Net()
const host = new Host(net, () => (account.loggedIn ? Promise.resolve(true) : loginForm.ask()))
const webcam = net && new Webcam(net)
if (net) {
  const chat = new Chat(net, () => session.paused)
  net.addEventListener("chat", (e) => {
    const msg = (e as CustomEvent<Extract<ServerMessage, { t: "chat" }>>).detail
    chat.add(msg.messages, msg.reset)
  })
  net.addEventListener("rtc", (e) => void webcam!.onSignal((e as CustomEvent<Extract<ServerMessage, { t: "rtc" }>>).detail.signal))
}
new PauseMenu(session, host, board, hud, webcam)
const teamLabel = (seat: 0 | 1) => (seat === 0 ? "Rouge" : "Bleu")

const showAccount = () => session.set({ account: account.loggedIn ? (account.username ?? "") : null })
account.addEventListener("change", showAccount)
showAccount()
// Checks a session kept from a previous visit (and reads its username)
if (account.loggedIn) void account.whoami()

type Detail<T extends HostMessage["t"]> = Extract<HostMessage, { t: T }>
const on = <T extends HostMessage["t"]>(type: T, listener: (msg: Detail<T>) => void) =>
  host.addEventListener(type, (e) => listener((e as CustomEvent<Detail<T>>).detail))

host.addEventListener("open", () => session.set({ online: true }))
host.addEventListener("close", () => session.set({ online: false, paused: false }))
on("welcome", (msg) => {
  board.setSeatView(msg.seat ?? 0)
  board.setViewer(msg.seat)
  session.set({ seat: msg.seat, urls: msg.urls, secureUrls: msg.secureUrls })
  webcam?.joined(msg.seat)
})
on("official", (msg) => {
  if (msg.seat !== session.seat) board.setSeatView(msg.seat ?? 0)
  board.setViewer(msg.seat)
  session.set({ official: msg.status, seat: msg.seat })
})
on("lobby", (msg) => session.set({ state: null, connected: msg.connected, lobbyMode: msg.mode }))
on("state", (msg) => {
  const prev: GameState | null = session.state
  const animate = !!prev && prev.heights.join() === msg.state.heights.join() && msg.state.ply === prev.ply + 1
  board.setState(msg.state, animate)
  session.set({ state: msg.state, connected: msg.connected, stateReceivedAt: Date.now() })
})
on("error", (msg) => hud.toast(msg.message))

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
  // Without a local host there's nobody to watch: no badge until the official game gives us a side
  const status =
    seat !== null ? [{ color: seat === 0 ? 0xd8443a : 0x3a7bd8, label: `Tu es ${teamLabel(seat)}` }] : STANDALONE ? [] : [{ color: 0x888888, label: "Spectateur" }]
  const right: string[] = []
  if (state?.official) right.push(officialPlayers(state, session.stateReceivedAt).join("  vs  "))
  if (state) right.push(`Rouge ${state.score[0]} – ${state.score[1]} Bleu`, `Coup ${state.ply + 1}`)
  if (seat !== null && state && !connected[1 - seat]) right.push("⚠ adversaire déconnecté")
  hud.update({ status, right })
}
session.addEventListener("change", updateBar)
setInterval(() => session.state?.official && updateBar(), 250)

host.connect()

new Runner(
  new Parallel([
    new Functional({ tick: () => board.render() }),
    makeAppMachine(),
  ]),
  { rootContext: { host, board, hud, session } },
).start()
