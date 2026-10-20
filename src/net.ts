import type { ClientMessage, ServerMessage } from "../shared/protocol"

const TOKEN_KEY = "traversal-seat-token"

function storedToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? undefined
  } catch {
    return undefined
  }
}

/** WebSocket link to the host; dispatches one event per server message type */
export class Net extends EventTarget {
  private ws: WebSocket | null = null

  connect() {
    const protocol = location.protocol === "https:" ? "wss" : "ws"
    this.ws = new WebSocket(`${protocol}://${location.host}/ws`)
    this.ws.addEventListener("open", () => {
      this.dispatchEvent(new Event("open"))
      this.send({ t: "hello", token: storedToken() })
    })
    this.ws.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data) as ServerMessage
      if (msg.t === "welcome") {
        try {
          sessionStorage.setItem(TOKEN_KEY, msg.token)
        } catch {}
      }
      this.dispatchEvent(new CustomEvent(msg.t, { detail: msg }))
    })
    this.ws.addEventListener("close", () => {
      this.dispatchEvent(new Event("close"))
      setTimeout(() => this.connect(), 1500)
    })
  }

  send(msg: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }
}
