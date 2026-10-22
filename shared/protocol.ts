import type { Action, GameState, Seat, TerrainMode } from "./rules"

// Messages between the local host (server/server.ts) and its pages

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
