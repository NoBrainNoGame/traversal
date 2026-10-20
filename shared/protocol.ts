import type { Action, GameState, Seat, TerrainMode } from "./rules"

export type ClientMessage =
  | { t: "hello"; token?: string }
  | { t: "action"; action: Action }
  | { t: "newGame"; mode: TerrainMode }

export type ServerMessage =
  | { t: "welcome"; seat: Seat | null; token: string; urls: string[] }
  | { t: "lobby"; connected: [boolean, boolean]; mode: TerrainMode }
  | { t: "state"; state: GameState; connected: [boolean, boolean] }
  | { t: "error"; message: string }
