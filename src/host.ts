import type { ClientMessage, ServerMessage } from "../shared/protocol"
import type { Seat } from "../shared/rules"
import type { Net } from "./net"
import { OfficialGame, type OfficialKind, type OfficialStatus } from "./official"

/** The GitHub Pages build: no local host, only games on traversalgame.com */
export const STANDALONE = import.meta.env.MODE === "pages"

/** What the interface asks for: the local host's messages, plus the commands of a game on traversalgame.com */
export type Command =
  | ClientMessage
  | { t: "official"; kind: OfficialKind }
  /** Starts the last kind of official game again (after logging back in) */
  | { t: "officialRetry" }
  /** Leaves the official game (cancels a search or an invite) and returns to the local game or the menu */
  | { t: "officialLeave" }
  | { t: "officialGhost"; accept: boolean }
  | { t: "officialDraw"; accept: boolean }
  | { t: "officialOfferDraw" }
  | { t: "officialResign" }

/** What the interface hears: the local host's messages, plus where the game on traversalgame.com stands */
export type HostMessage =
  | ServerMessage
  /** status null: back to the local game. seat: which side this page plays from now on */
  | { t: "official"; status: OfficialStatus | null; seat: Seat | null }

/**
 * Where the game comes from: the local host (through the WebSocket, absent on GitHub Pages) or traversalgame.com,
 * played from this page through the relay. While an official game exists it replaces the local one on screen.
 * Dispatches one event per HostMessage type, plus "open" and "close".
 */
export class Host extends EventTarget {
  private official: OfficialGame | null = null
  private lastKind: OfficialKind = "bot"
  /** Our seat at the local host */
  private seat: Seat | null = null
  /** The local host's last lobby or state message, shown again when leaving the official game */
  private board: ServerMessage | null = null

  /** @param login asks for the traversalgame.com credentials when there's no session; resolves false if cancelled */
  constructor(
    private net: Net | null,
    private login: () => Promise<boolean>,
  ) {
    super()
    if (!net) return
    for (const type of ["open", "close"]) net.addEventListener(type, () => this.dispatchEvent(new Event(type)))
    for (const type of ["welcome", "lobby", "state", "error"]) net.addEventListener(type, (e) => this.fromNet((e as CustomEvent<ServerMessage>).detail))
  }

  connect() {
    if (this.net) return this.net.connect()
    this.dispatchEvent(new Event("open"))
    this.emit({ t: "welcome", seat: null, token: "", urls: [], secureUrls: [] })
    this.board = { t: "lobby", connected: [false, false], mode: "balanced" }
    this.emit(this.board)
  }

  send(cmd: Command) {
    const official = this.official
    switch (cmd.t) {
      case "official":
        this.lastKind = cmd.kind
        return void this.startOfficial()
      case "officialRetry":
        return void this.startOfficial()
      case "officialLeave":
        return void this.leaveOfficial()
      case "officialGhost":
        return void official?.answerGhost(cmd.accept)
      case "officialDraw":
        return official?.answerDraw(cmd.accept)
      case "officialOfferDraw":
        return official?.offerDraw()
      case "officialResign":
        return official?.resign()
      case "action": {
        if (!official) break
        const error = official.play(cmd.action)
        if (error) this.notice(error)
        return
      }
      case "newGame":
        if (!official) break
        if (official.live) return this.notice("Abandonne d'abord la partie sur traversalgame.com.")
        void this.leaveOfficial()
        break
      case "swapSeats":
        if (official) return this.notice("Les camps sont fixés par traversalgame.com.")
    }
    this.net?.send(cmd)
  }

  private fromNet(msg: ServerMessage) {
    if (msg.t === "welcome") this.seat = msg.seat
    if (msg.t === "lobby" || msg.t === "state") this.board = msg
    // The local game stays hidden behind the official one
    if (this.official && msg.t !== "error") return msg.t === "welcome" && this.emit({ ...msg, seat: this.official.seat })
    this.emit(msg)
  }

  private async startOfficial() {
    if (this.official?.live) return this.notice("Une partie est déjà en cours sur traversalgame.com.")
    if (!(await this.login())) return
    // A finished game or a pending search is replaced by the new one
    const previous = this.official
    const game = new OfficialGame(
      () => this.showOfficial(game),
      (message) => this.notice(message),
    )
    this.official = game
    this.showOfficial(game)
    void previous?.leave()
    void game.start(this.lastKind)
  }

  private showOfficial(game: OfficialGame) {
    if (this.official !== game) return
    this.emit({ t: "official", status: game.status, seat: game.seat })
    if (game.state) this.emit({ t: "state", state: game.state, connected: [true, true] })
  }

  private async leaveOfficial() {
    const leaving = this.official
    if (!leaving) return
    this.official = null
    this.emit({ t: "official", status: null, seat: this.seat })
    if (this.board) this.emit(this.board)
    await leaving.leave()
  }

  private notice(message: string) {
    this.emit({ t: "error", message })
  }

  private emit(msg: HostMessage) {
    this.dispatchEvent(new CustomEvent(msg.t, { detail: msg }))
  }
}
