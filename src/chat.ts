import type { ChatMessage } from "../shared/protocol"
import type { Net } from "./net"

const ffz = (id: number) => `https://cdn.frankerfacez.com/emote/${id}/2`

/** Twitch / FrankerFaceZ emotes, written :name: in messages */
export const EMOTES: Record<string, string> = {
  kappa: "https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0",
  harold: ffz(268786),
  pepefrog: ffz(109777),
  feelsbadman: ffz(33355),
  pepehands: ffz(231552),
  pepelaugh: ffz(64785),
  kekw: ffz(381875),
  lulw: ffz(139407),
  monkas: ffz(130762),
}
const EMOJIS = ["👍", "😂", "😭", "🔥", "👀", "🎉", "GG"]

/** Text with its :emotes: turned into images (built with DOM nodes, never parsed as HTML) */
function renderText(text: string) {
  const out = document.createDocumentFragment()
  text.split(/(:[a-z0-9_]+:)/i).forEach((part, i) => {
    const url = i % 2 ? EMOTES[part.slice(1, -1).toLowerCase()] : undefined
    if (!url) return out.append(part)
    const img = document.createElement("img")
    img.src = url
    img.alt = img.title = part
    out.append(img)
  })
  return out
}

/** Chat panel in the bottom right corner (HTML over the canvases, so it can take text input) */
export class Chat {
  private root = document.getElementById("chat")!
  private list = document.createElement("div")
  private input = document.createElement("input")
  private picker = document.createElement("div")

  constructor(
    private net: Net,
    /** True while the pause menu is open: Enter then doesn't open the chat */
    private paused: () => boolean,
  ) {
    this.list.className = "chat-list"
    this.picker.className = "chat-picker"
    this.picker.hidden = true
    for (const [name, url] of Object.entries(EMOTES)) {
      const img = document.createElement("img")
      img.src = url
      img.alt = img.title = `:${name}:`
      this.picker.append(this.pickerButton(img, `:${name}:`))
    }
    for (const emoji of EMOJIS) this.picker.append(this.pickerButton(document.createTextNode(emoji), emoji))

    const toggle = document.createElement("button")
    toggle.className = "chat-toggle"
    toggle.title = "Emotes"
    toggle.append(Object.assign(document.createElement("img"), { src: EMOTES.pepefrog, alt: "Emotes" }))
    toggle.addEventListener("click", () => {
      this.picker.hidden = !this.picker.hidden
      this.input.focus()
    })

    this.input.placeholder = "Entrée pour discuter…"
    this.input.maxLength = 300
    this.input.addEventListener("keydown", (e) => {
      // Keys typed here are for the chat only (Escape would open the pause menu or deselect)
      e.stopPropagation()
      if (e.key === "Enter") {
        const text = this.input.value.trim()
        if (text) this.net.send({ t: "chat", text })
        this.input.value = ""
        if (!text) this.input.blur()
      } else if (e.key === "Escape") this.input.blur()
    })
    this.input.addEventListener("blur", () => (this.picker.hidden = true))

    const row = document.createElement("div")
    row.className = "chat-row"
    row.append(this.input, toggle)
    this.root.append(this.list, this.picker, row)

    addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !this.paused() && document.activeElement !== this.input) {
        e.preventDefault()
        this.input.focus()
      }
    })
  }

  private pickerButton(content: Node, insert: string) {
    const button = document.createElement("button")
    button.append(content)
    // Keep the focus in the input while picking
    button.addEventListener("mousedown", (e) => e.preventDefault())
    button.addEventListener("click", () => {
      const value = this.input.value
      this.input.value = value + (value && !value.endsWith(" ") ? " " : "") + insert + " "
      this.input.focus()
    })
    return button
  }

  add(messages: ChatMessage[], reset = false) {
    if (reset) this.list.replaceChildren()
    for (const m of messages) {
      const line = document.createElement("div")
      const name = document.createElement("b")
      name.textContent = m.from
      name.style.color = m.color
      line.append(name, " ", renderText(m.text))
      this.list.append(line)
    }
    this.list.scrollTop = this.list.scrollHeight
  }
}
