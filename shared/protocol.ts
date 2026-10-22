import type { Action, GameState, Seat, TerrainMode } from "./rules"

export type OfficialKind = "bot" | "match" | "friend"

/** Where a game on traversalgame.com stands, before and during play */
export interface OfficialStatus {
  phase: "starting" | "searching" | "ghost" | "waiting" | "playing" | "over" | "error"
  message: string
  /** Invite link to send to a friend */
  link?: string
  /** The site's login page, when the Firefox session is missing or expired */
  login?: string
  /** Username of an opponent offering a draw */
  drawOffer?: string
}

/** A line of the chat between the people connected to this host */
export interface ChatMessage {
  from: string
  /** The speaker's team colour (spectators are grey) */
  color: string
  text: string
}

/** WebRTC signalling for the webcams, relayed as is to the other player */
export type RtcSignal =
  /** The sender just connected or turned its camera on: start the connection over */
  | { kind: "hello" }
  /** The sender turned its camera off */
  | { kind: "bye" }
  | { kind: "description"; description: { type: string; sdp?: string } }
  | { kind: "candidate"; candidate: unknown }

export type ClientMessage =
  | { t: "hello"; token?: string }
  | { t: "action"; action: Action }
  | { t: "newGame"; mode: TerrainMode }
  | { t: "official"; kind: OfficialKind }
  /** Leaves the official game (cancels a search or an invite) and returns to the local game */
  | { t: "officialLeave" }
  | { t: "officialGhost"; accept: boolean }
  | { t: "officialDraw"; accept: boolean }
  | { t: "officialOfferDraw" }
  | { t: "officialResign" }
  /** The two players trade colours (local game only) */
  | { t: "swapSeats" }
  | { t: "chat"; text: string }
  | { t: "rtc"; signal: RtcSignal }

export type ServerMessage =
  /** urls: addresses for a friend on the network; secureUrls: the same over https, needed for their webcam */
  | { t: "welcome"; seat: Seat | null; token: string; urls: string[]; secureUrls: string[] }
  | { t: "lobby"; connected: [boolean, boolean]; mode: TerrainMode }
  | { t: "state"; state: GameState; connected: [boolean, boolean] }
  | { t: "error"; message: string }
  /** reset: the whole history (on connection), otherwise new lines */
  | { t: "chat"; messages: ChatMessage[]; reset?: boolean }
  | { t: "rtc"; signal: RtcSignal }
  /** status null: back to the local game. seat: which side this client plays from now on */
  | { t: "official"; status: OfficialStatus | null; seat: Seat | null }
