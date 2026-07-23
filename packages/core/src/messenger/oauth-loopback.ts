export * as OAuthLoopback from "./oauth-loopback"

import { spawn } from "node:child_process"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { Effect } from "effect"
import { ConnectError } from "./driver"
import { OauthCallbackPage } from "../oauth/page"

// The loopback redirect catcher for the auth-code OAuth flow (Gmail "Sign in with Google", P9). A
// scoped HTTP server on 127.0.0.1:<ephemeral> that catches ONE OAuth redirect and hands back the
// authorization code. Modeled on the MCP loopback (packages/novaclaw/src/mcp/oauth-callback.ts) but
// SCOPED to the caller's Effect Scope — the messenger login attempt owns the scope, so the server
// lives exactly from begin() until complete/cancel/expiry and never leaks. Google's loopback flow
// allows ANY 127.0.0.1 port for Desktop-type clients, so an ephemeral port needs no registration.
// Injected into the Gmail driver as a factory seam (like the mail/oauth factories) so the login flow
// is fake-testable without real sockets or a browser.

export interface Loopback {
  /** The `http://127.0.0.1:<port>/` the auth URL must redirect to (bound port, path always `/`). */
  readonly redirectUri: string
  /** Resolves with the authorization `code` once the browser hits the redirect with a matching
   *  `state`; rejects on an OAuth error redirect, a state mismatch, timeout, or scope close. The
   *  driver awaits this inside its login fiber, so the rejection is always handled. */
  readonly waitForCode: Promise<string>
}

export interface LoopbackParams {
  /** The opaque state minted for this attempt — the callback must echo it (CSRF binding). */
  readonly expectedState: string
  /** Friendly name shown on the branded callback page ("Gmail"). */
  readonly provider?: string
  /** Reject waitForCode if no redirect arrives in this many ms (default 5 min; the attempt scope
   *  also caps the whole login at 10 min). */
  readonly timeoutMs?: number
  /** A FIXED loopback port, for providers that match the redirect URI EXACTLY (Reddit) instead of
   *  ignoring the port like Google does for Desktop clients. When set, the URI is deterministic so
   *  the user can register it up front; a busy port fails legibly instead of silently mismatching. */
  readonly port?: number
  /** The exact redirect URI string to advertise, when it must match a value registered by hand
   *  (Reddit). Defaults to `http://127.0.0.1:<bound port>/`. Whatever is passed here is what the
   *  user must have registered — keep it byte-identical to the setup instructions. */
  readonly redirectUri?: string
}

export type LoopbackFactory = (params: LoopbackParams) => Effect.Effect<Loopback, ConnectError, import("effect").Scope.Scope>

/** Start a scoped loopback server. The server closes (and a still-pending waitForCode rejects) when
 *  the Effect scope closes. */
export const startLoopback: LoopbackFactory = (params) =>
  Effect.gen(function* () {
    let resolveCode!: (code: string) => void
    let rejectCode!: (error: Error) => void
    let settled = false
    const codePromise = new Promise<string>((resolve, reject) => {
      resolveCode = (code) => {
        if (settled) return
        settled = true
        resolve(code)
      }
      rejectCode = (error) => {
        if (settled) return
        settled = true
        reject(error)
      }
    })

    const handler = (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1")
      if (url.pathname !== "/") {
        res.writeHead(404)
        res.end("Not found")
        return
      }
      const code = url.searchParams.get("code")
      const state = url.searchParams.get("state")
      const error = url.searchParams.get("error")
      const errorDescription = url.searchParams.get("error_description")
      const page = (status: 200 | 400, html: string) => {
        res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" })
        res.end(html)
      }
      // Bind the redirect to this attempt (CSRF): a mismatched/absent state is rejected, never used.
      if (state !== params.expectedState) {
        page(400, OauthCallbackPage.error("This sign-in link doesn't match the request — start again.", { provider: params.provider }))
        return
      }
      if (error) {
        const message = errorDescription || error
        page(200, OauthCallbackPage.error(message, { provider: params.provider }))
        rejectCode(new Error(message))
        return
      }
      if (!code) {
        page(400, OauthCallbackPage.error("No authorization code in the redirect.", { provider: params.provider }))
        return
      }
      page(200, OauthCallbackPage.success({ provider: params.provider }))
      resolveCode(code)
    }

    const server = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          new Promise<ReturnType<typeof createServer>>((resolve, reject) => {
            const s = createServer(handler)
            s.once("error", reject)
            // Port 0 = an ephemeral port (Google ignores it); a fixed port is for providers that
            // match the redirect URI exactly (Reddit) — see LoopbackParams.port.
            s.listen(params.port ?? 0, "127.0.0.1", () => resolve(s))
          }),
        catch: (error) => {
          const busy = (error as { code?: string })?.code === "EADDRINUSE" && params.port !== undefined
          return new ConnectError({
            reason: busy
              ? `The sign-in port ${params.port} is already in use — close whatever is using it (another sign-in, or another app) and try again.`
              : `Could not start the local sign-in listener: ${String(error)}`,
          })
        },
      }),
      (s) =>
        Effect.sync(() => {
          try {
            s.close()
          } catch {
            /* already closed */
          }
          rejectCode(new Error("Sign-in cancelled."))
        }),
    )

    const address = server.address()
    const port = typeof address === "object" && address !== null ? address.port : 0
    if (port === 0) return yield* Effect.fail(new ConnectError({ reason: "Could not bind the local sign-in listener." }))

    const timeoutMs = params.timeoutMs ?? 5 * 60 * 1000
    const timer = setTimeout(() => rejectCode(new Error("Timed out waiting for the browser sign-in — try again.")), timeoutMs)
    yield* Effect.addFinalizer(() => Effect.sync(() => clearTimeout(timer)))

    return { redirectUri: params.redirectUri ?? `http://127.0.0.1:${port}/`, waitForCode: codePromise }
  })

/** Best-effort: open the user's default browser at `url`. Failure is fine — the login instructions
 *  always include the URL as a fallback (and a truly-remote/headless instance has no browser). Runs
 *  on the SERVER host, so this only helps a local-first instance; that's the intended lay case. */
export const openBrowser = (url: string): Effect.Effect<void> =>
  Effect.sync(() => {
    try {
      const platform = process.platform
      // rundll32 opens URLs on Windows without cmd's `&`-in-query escaping hazards; open/xdg-open elsewhere.
      const [command, args] =
        platform === "win32"
          ? (["rundll32.exe", ["url.dll,FileProtocolHandler", url]] as const)
          : platform === "darwin"
            ? (["open", [url]] as const)
            : (["xdg-open", [url]] as const)
      const child = spawn(command, [...args], { detached: true, stdio: "ignore" })
      child.once("error", () => {
        /* no browser here — the user opens the URL from the instructions */
      })
      child.unref()
    } catch {
      /* ignore — the instructions carry the URL */
    }
  })
