import type { Action, GameState, Seat, TerrainMode } from "./rules"

export type OfficialKind = "bot" | "match" | "friend"

/** Where a game on traversalgame.com stands, before and during play */
export interface OfficialStatus {
  phase: "starting" | "searching" | "ghost" | "waiting" | "playing" | "over" | "error"
  message: string
  /** Invite link to send to a friend */
  link?: string
  /** Username of an opponent offering a draw */
  drawOffer?: string
}

export type ClientMessage =
  | { t: "hello"; token?: string }
  | { t: "action"; action: Action }
  | { t: "newGame"; mode: TerrainMode }
  | { t: "official"; kind: OfficialKind }
  /** Leaves the official game (cancels a search or an invite) and returns to the local game */
  | { t: "officialLeave" }
  | { t: "officialGhost"; accept: boolean }
  | { t: "officialDraw"; accept: boolean }

export type ServerMessage =
  | { t: "welcome"; seat: Seat | null; token: string; urls: string[] }
  | { t: "lobby"; connected: [boolean, boolean]; mode: TerrainMode }
  | { t: "state"; state: GameState; connected: [boolean, boolean] }
  | { t: "error"; message: string }
  /** status null: back to the local game. seat: which side this client plays from now on */
  | { t: "official"; status: OfficialStatus | null; seat: Seat | null }
