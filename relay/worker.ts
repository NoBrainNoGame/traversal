// Cloudflare Worker between the client and traversalgame.com (with its developer's permission).
// The site only answers its own origin and keeps the session in HttpOnly cookies, out of reach of another site:
// the relay calls the API as www.traversalgame.com and hands the session cookies to the client as an opaque token,
// which comes back in a header (or in the query string for the game WebSocket). It stores nothing.

const API = "https://api.traversalgame.com"
const SITE = "https://www.traversalgame.com"
const USER_AGENT = "TraversalNoBrainNoGameClient/1.0 (unofficial client, https://github.com/NoBrainNoGame/traversal)"
const SESSION_HEADER = "x-traversal-session"
const ROUTES = /^\/(auth|me|api|ws)(\/|$)/

/** No cookie of ours rides along (the token is sent by hand), so any page may call the relay */
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": `content-type, ${SESSION_HEADER}`,
  "access-control-expose-headers": SESSION_HEADER,
  "access-control-max-age": "86400",
}

type Jar = Record<string, string>

function readToken(token: string | null): Jar {
  if (!token) return {}
  try {
    return JSON.parse(atob(token.replace(/-/g, "+").replace(/_/g, "/")))
  } catch {
    return {}
  }
}

const writeToken = (jar: Jar) => btoa(JSON.stringify(jar)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

/** Like the browser: the refresh cookie only goes to the refresh route */
const cookieHeader = (jar: Jar, path: string) =>
  Object.entries(jar)
    .filter(([name]) => name !== "traversal_refresh" || path.startsWith("/auth/refresh"))
    .map(([name, value]) => `${name}=${value}`)
    .join("; ")

/** Applies the API's Set-Cookie headers to the jar; true if anything changed */
function absorb(jar: Jar, res: Response) {
  let changed = false
  for (const line of res.headers.getSetCookie()) {
    const pair = line.split(";")[0]
    const eq = pair.indexOf("=")
    const name = pair.slice(0, eq).trim(),
      value = pair.slice(eq + 1).trim()
    if (!value || /max-age=0\b/i.test(line)) delete jar[name]
    else jar[name] = value
    changed = true
  }
  return changed
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS })
    const url = new URL(request.url)
    if (!ROUTES.test(url.pathname)) return new Response("Not found", { status: 404, headers: CORS })

    const upgrade = request.headers.get("upgrade")?.toLowerCase() === "websocket"
    const jar = readToken(upgrade ? url.searchParams.get("session") : request.headers.get(SESSION_HEADER))
    url.searchParams.delete("session")
    const headers = new Headers({ origin: SITE, referer: SITE + "/", "user-agent": USER_AGENT })
    const cookie = cookieHeader(jar, url.pathname)
    if (cookie) headers.set("cookie", cookie)
    const target = API + url.pathname + url.search

    // The game socket: the upstream connection is handed straight back to the client
    if (upgrade) {
      for (const name of ["upgrade", "connection", "sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol", "sec-websocket-extensions"]) {
        const value = request.headers.get(name)
        if (value) headers.set(name, value)
      }
      return fetch(target, { headers })
    }

    const type = request.headers.get("content-type")
    if (type) headers.set("content-type", type)
    const res = await fetch(target, { method: request.method, headers, body: request.body, redirect: "manual" })
    const out = new Headers(CORS)
    for (const name of ["content-type", "cache-control"]) {
      const value = res.headers.get(name)
      if (value) out.set(name, value)
    }
    if (absorb(jar, res)) out.set(SESSION_HEADER, writeToken(jar))
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out })
  },
}
