export * from "./gen/types.gen.js"
export type { FileSystemEntry as LocationFileSystemEntry } from "./gen/types.gen.js"
// The V2 spec renamed the API-config schema `Config` → `ConfigInfo`; keep the sdk's public name
// stable (three app consumers) — same shape, renamed identifier.
export type { ConfigInfo as Config } from "./gen/types.gen.js"

import { createClient } from "./gen/client/client.gen.js"
import { type Config } from "./gen/client/types.gen.js"
import { NovaclawClient } from "./gen/sdk.gen.js"
import { wrapClientError } from "../error-interceptor.js"

/**
 * The server answered an API call with a page instead of a body: an older server without the
 * route, or a proxy handing back its own HTML. Thrown by the response interceptor below.
 *
 * ⚠️ A CLASS, not a sentence. A caller that wants to ignore this case (the terminal does — an
 * instance without the pty routes is not an error worth a toast) tests `instanceof`; until
 * 2026-09-03 the one caller matched `message.includes("Request is not supported")`, which meant
 * rewording this text would have turned a quiet fallback into a thrown error two packages away.
 */
export class UnsupportedRequestError extends Error {
  override readonly name = "UnsupportedRequestError"
  constructor(readonly contentType: string) {
    super(`Request is not supported by this version of NovaClaw Server (Server responded with ${contentType})`)
  }
}
export { type Config as NovaclawClientConfig, NovaclawClient }

/**
 * The value to carry in the QUERY, given what the request's header holds and what the client was
 * configured with.
 *
 * ⚠️ **A header and a query param want the value in DIFFERENT forms, and mixing them corrupts the
 * directory.** A header cannot carry arbitrary bytes, so `x-novaclaw-directory` is
 * percent-ENCODED and the server decodes it. A query param is encoded by `URLSearchParams` on the
 * way out and decoded on the way in, so its value must be RAW — the server reads
 * `location[directory]` verbatim, exactly once decoded by the URL parser.
 *
 * So every branch here must return the RAW path. The `encode(fallback)` case already did that; the
 * no-fallback case did not, and returned the still-encoded header instead. Measured 2026-08-11
 * against a live instance: `GET /api/location` with a manually set header and no configured
 * directory resolved to `C%3A%5CUsers%5C…` — the literal encoded string, as a path.
 */
function pick(value: string | null, fallback?: string, encode?: (value: string) => string) {
  if (!value) return
  if (!fallback) return decode(value, encode)
  if (value === fallback) return fallback
  if (encode && value === encode(fallback)) return fallback
  return value
}

/** Undo the header's encoding. A value that is not valid percent-encoding is already raw. */
function decode(value: string, encode?: (value: string) => string) {
  if (!encode) return value
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function rewrite(request: Request, values: { directory?: string; workspace?: string }) {
  if (request.method !== "GET" && request.method !== "HEAD") return request

  const url = new URL(request.url)
  let changed = false

  for (const [name, key] of [
    ["x-novaclaw-directory", "directory"],
    ["x-novaclaw-workspace", "workspace"],
  ] as const) {
    const value = pick(
      request.headers.get(name),
      key === "directory" ? values.directory : values.workspace,
      key === "directory" ? encodeURIComponent : undefined,
    )
    if (!value) continue
    for (const query of url.pathname.startsWith("/api/") ? [key, `location[${key}]`] : [key]) {
      if (!url.searchParams.has(query)) {
        url.searchParams.set(query, value)
      }
    }
    changed = true
  }

  if (!changed) return request

  const next = new Request(url, request)
  next.headers.delete("x-novaclaw-directory")
  next.headers.delete("x-novaclaw-workspace")
  return next
}

export function createNovaclawClient(config?: Config & { directory?: string; experimental_workspaceID?: string }) {
  if (!config?.fetch) {
    const customFetch: any = (req: any) => {
      // @ts-ignore
      req.timeout = false
      return fetch(req)
    }
    config = {
      ...config,
      fetch: customFetch,
    }
  }

  if (config?.directory) {
    config.headers = {
      ...config.headers,
      "x-novaclaw-directory": encodeURIComponent(config.directory),
    }
  }

  if (config?.experimental_workspaceID) {
    config.headers = {
      ...config.headers,
      "x-novaclaw-workspace": config.experimental_workspaceID,
    }
  }

  const client = createClient(config)
  client.interceptors.request.use((request) =>
    rewrite(request, {
      directory: config?.directory,
      workspace: config?.experimental_workspaceID,
    }),
  )
  client.interceptors.response.use((response) => {
    const contentType = response.headers.get("content-type")
    if (contentType === "text/html") throw new UnsupportedRequestError(contentType)

    return response
  })
  client.interceptors.error.use(wrapClientError)
  return new NovaclawClient({ client })
}
