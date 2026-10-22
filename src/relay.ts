// Client side of the Cloudflare relay (relay/worker.ts): calls traversalgame.com's API through it, keeping the
// session token it hands out in this browser.

/** Where relay/worker.ts is deployed (VITE_RELAY_URL overrides it, e.g. for `wrangler dev`) */
const RELAY: string = import.meta.env.VITE_RELAY_URL ?? "https://traversal-relay.nobrainnogame.workers.dev"
const SESSION_HEADER = "x-traversal-session"
const TOKEN_KEY = "traversal-official-session"

export class OfficialError extends Error {
  /** The fix is to log in (again) */
  login = false
}

/** No session, or an expired one */
export const loginError = (message: string) => Object.assign(new OfficialError(message), { login: true })

export interface ApiResult {
  status: number
  ok: boolean
  data: any
}

export function errorMessage(data: any, fallback: string): string {
  const detail = data?.detail
  if (typeof detail === "string") return detail
  if (typeof detail?.message === "string") return detail.message
  if (typeof data?.message === "string") return data.message
  if (typeof data?.code === "string") return data.code
  return fallback
}

function storedToken() {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

function storeToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {}
}

/** The traversalgame.com account used by this browser */
class Account extends EventTarget {
  private token = storedToken()
  /** Username, once known */
  username: string | null = null

  get loggedIn() {
    return !!this.token
  }

  /** Calls the API; on 401, refreshes the session once and retries */
  async api(path: string, method = "GET", body?: unknown): Promise<ApiResult> {
    if (!this.token) throw loginError("Connecte-toi à ton compte traversalgame.com.")
    let res = await this.call(path, method, body)
    if (res.status === 401 && (await this.call("/auth/refresh", "POST")).ok) res = await this.call(path, method, body)
    if (res.status === 401) {
      this.forget()
      throw loginError("Session expirée : reconnecte-toi à ton compte traversalgame.com.")
    }
    return this.parse(res)
  }

  async login(email: string, password: string) {
    const res = await this.parse(await this.call("/auth/login", "POST", { email, password }))
    if (!res.ok || !this.token) {
      this.forget()
      throw new OfficialError(errorMessage(res.data, "Identifiants refusés par traversalgame.com."))
    }
    await this.whoami()
  }

  async logout() {
    try {
      if (this.token) await this.call("/auth/logout", "POST")
    } catch {}
    this.forget()
  }

  /** Reads the username; false if the stored session no longer works */
  async whoami() {
    try {
      const me = await this.api("/me")
      if (!me.ok) return false
      this.username = me.data?.username ?? null
      this.dispatchEvent(new Event("change"))
      return true
    } catch {
      return false
    }
  }

  /** The game socket goes through the relay too, the token in the query string (sockets can't carry headers) */
  socketUrl(path: string) {
    return `${RELAY.replace(/^http/, "ws")}${path}?session=${encodeURIComponent(this.token ?? "")}`
  }

  private async call(path: string, method: string, body?: unknown) {
    const headers: Record<string, string> = {}
    if (this.token) headers[SESSION_HEADER] = this.token
    if (body !== undefined) headers["content-type"] = "application/json"
    const res = await fetch(RELAY + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined })
    const token = res.headers.get(SESSION_HEADER)
    if (token !== null) this.setToken(token === "e30" ? null : token)
    return res
  }

  private async parse(res: Response): Promise<ApiResult> {
    let data: any = null
    try {
      data = JSON.parse(await res.text())
    } catch {}
    return { status: res.status, ok: res.ok, data }
  }

  private forget() {
    this.username = null
    this.setToken(null)
  }

  private setToken(token: string | null) {
    const changed = token !== this.token
    this.token = token
    storeToken(token)
    if (changed) this.dispatchEvent(new Event("change"))
  }
}

export const account = new Account()
