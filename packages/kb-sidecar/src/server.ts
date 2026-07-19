// The memory sidecar's loopback HTTP face. The Bun kernel spawns this Node process (P0: the addon
// segfaults under Bun) and talks to it over 127.0.0.1 only — never egresses (OFF-C). A shared
// bearer token (the kernel generates it, passes it in) gates every request so other local processes
// can't poke the memory. Raw node:http (no deps) so it runs on the Spark's Node 18 too.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { MemoryStore } from "./store.ts"

export interface ServerOptions {
  /** Shared bearer token required on every request (except /health). Omit only for tests. */
  readonly token?: string
}

const readBody = (req: IncomingMessage): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on("data", (c: Buffer) => {
      size += c.length
      if (size > 64 * 1024 * 1024) {
        reject(new Error("request body too large"))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8")
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error("invalid JSON body"))
      }
    })
    req.on("error", reject)
  })

const send = (res: ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body)
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) })
  res.end(payload)
}

/** Build the memory sidecar HTTP server over an open store. Caller owns `listen()`/`close()`. */
export function createMemoryServer(store: MemoryStore, opts: ServerOptions = {}): Server {
  const routes: Record<string, (body: Record<string, unknown>) => Promise<unknown>> = {
    "/add": async (b) => {
      await store.addMemory(b as never)
      return { ok: true }
    },
    "/addEdge": async (b) => {
      await store.addEdge(b as never)
      return { ok: true }
    },
    "/search": async (b) => ({ hits: await store.search(b as never) }),
    "/neighbors": async (b) => ({
      neighbors: await store.neighbors(String(b.id), {
        scopes: b.scopes as string[] | undefined,
        k: b.k as number | undefined,
      }),
    }),
    "/path": async (b) => ({ path: await store.path(String(b.from), String(b.to), b.maxHops as number | undefined) }),
    "/invalidate": async (b) => {
      await store.invalidate(String(b.id), b.at as string | undefined)
      return { ok: true }
    },
    "/purge": async (b) => {
      await store.purge(String(b.id))
      return { ok: true }
    },
    "/clearScope": async (b) => {
      await store.clearScope(String(b.scope))
      return { ok: true }
    },
    "/stats": async () => ({ stats: await store.stats() }),
  }

  return createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? "").split("?")[0]
      // Liveness — no auth, so the supervisor can poll a still-initializing/locked instance.
      if (path === "/health") return send(res, 200, { ok: true })
      if (opts.token) {
        const auth = req.headers.authorization
        if (auth !== `Bearer ${opts.token}`) return send(res, 401, { error: "unauthorized" })
      }
      const route = routes[path]
      if (req.method !== "POST" || !route) return send(res, 404, { error: `no route ${req.method} ${path}` })
      try {
        const body = (await readBody(req)) as Record<string, unknown>
        send(res, 200, await route(body))
      } catch (error) {
        send(res, 400, { error: String((error as Error).message) })
      }
    })().catch((error) => {
      try {
        send(res, 500, { error: String((error as Error).message) })
      } catch {
        /* response already sent */
      }
    })
  })
}
