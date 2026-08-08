// Subprocess integration tests for `novaclaw serve`. Spawns the real CLI in
// headless mode and exercises it over HTTP — this is the only test tier that
// catches bugs spanning argv → server boot → routing → instance loading.
//
// `serve` is long-lived: the harness returns a handle (url/port/kill/exited)
// and kills the process when the test scope closes. The OS-assigned port is
// parsed off the "listening on http://..." line.
import { describe, expect } from "bun:test"
import { Effect, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import { Location } from "@novaclaw/core/location"
import { Pty } from "@novaclaw/core/pty"
import { killTreeSync } from "@novaclaw/core/util/kill-tree"
import { cliIt, type CliFixture } from "../../lib/cli-process"

function hardKill(pid: number): void {
  if (process.platform !== "win32") {
    process.kill(pid, "SIGKILL")
    return
  }
  killTreeSync(pid)
}

describe("novaclaw serve (subprocess)", () => {
  // Smoke test: server starts, binds a port, and /global/health responds.
  // If this fails, all other serve tests likely will too — debug here first.
  cliIt.live(
    "starts, binds a port, and serves /global/health",
    ({ novaclaw }) =>
      Effect.gen(function* () {
        const server = yield* novaclaw.serve()
        expect(server.port).toBeGreaterThan(0)
        expect(server.url).toMatch(/^http:\/\//)

        const client = yield* HttpClient.HttpClient
        const res = yield* client.get(`${server.url}/global/health`)
        expect(res.status).toBe(200)
        // GlobalHealth schema is { success: true, ... } | { success: false, error }.
        // We don't lock in further shape here — any 200 with parseable JSON is
        // enough proof the routing + auth-bypass + instance loading is alive.
        const body = yield* res.json
        expect(body).toBeDefined()
      }),
    60_000,
  )

  // The scope-close finalizer must actually terminate the child. Without this
  // test a regression in the kill path (e.g. a future refactor that forgets
  // to wire the finalizer) would leak processes on every test run.
  cliIt.live(
    "replaces a hard-killed server child and serves health again",
    ({ novaclaw }) =>
      Effect.gen(function* () {
        // Reserve a stable port: production reconnects to one configured URL, whereas port 0 may
        // legitimately choose a different address for the replacement child.
        const reservation = Bun.serve({ port: 0, fetch: () => new Response("reserved") })
        const port = reservation.port
        yield* Effect.promise(() => reservation.stop(true))

        const server = yield* novaclaw.serve({ port, supervise: true })
        const firstPID = server.childPID
        expect(firstPID).toBeGreaterThan(0)
        if (firstPID === undefined) throw new Error("supervisor did not report its initial child pid")

        hardKill(firstPID)

        const replacement = yield* Effect.promise(() => server.waitForRestart(firstPID))
        expect(replacement.pid).not.toBe(firstPID)
        expect(replacement.url).toBe(server.url)

        const response = yield* Effect.promise(() => fetch(`${server.url}/global/health`))
        expect(response.status).toBe(200)
      }),
    60_000,
  )

  const terminalRestart = ({ novaclaw, home }: CliFixture) =>
    Effect.gen(function* () {
      const reservation = Bun.serve({ port: 0, fetch: () => new Response("reserved") })
      const port = reservation.port
      yield* Effect.promise(() => reservation.stop(true))

      const server = yield* novaclaw.serve({ port, supervise: true })
      const firstPID = server.childPID
      if (firstPID === undefined) throw new Error("supervisor did not report its initial child pid")
      const headers = { "content-type": "application/json", "x-novaclaw-directory": home }
      const created = yield* Effect.promise(() =>
        fetch(`${server.url}/api/pty`, {
          method: "POST",
          headers,
          body: JSON.stringify({ command: "/usr/bin/env", args: ["sh", "-c", "sleep 30"], title: "before-crash" }),
        }),
      )
      expect(created.status).toBe(200)
      const first = Schema.decodeUnknownSync(Location.response(Pty.Info))(yield* Effect.promise(() => created.json()))
      expect(first.data.status).toBe("running")
      expect(first.data.pid).toBeGreaterThan(0)

      hardKill(firstPID)
      const replacement = yield* Effect.promise(() => server.waitForRestart(firstPID))
      expect(replacement.url).toBe(server.url)

      const descendantDeadline = Date.now() + 5_000
      let descendantAlive = true
      while (descendantAlive && Date.now() < descendantDeadline) {
        try {
          process.kill(first.data.pid, 0)
          yield* Effect.sleep("25 millis")
        } catch {
          descendantAlive = false
        }
      }
      expect(descendantAlive).toBe(false)

      const route = `${server.url}/api/instance/pty?location[directory]=${encodeURIComponent(home)}`
      const reconciled = yield* Effect.promise(() => fetch(route, { headers }))
      expect(reconciled.status).toBe(200)
      expect(yield* Effect.promise(() => reconciled.json())).toEqual([])

      const recreated = yield* Effect.promise(() =>
        fetch(`${server.url}/api/pty`, {
          method: "POST",
          headers,
          body: JSON.stringify({ command: "/usr/bin/env", args: ["sh", "-c", "sleep 30"], title: "after-crash" }),
        }),
      )
      expect(recreated.status).toBe(200)
      const second = Schema.decodeUnknownSync(Location.response(Pty.Info))(yield* Effect.promise(() => recreated.json()))
      expect(second.data.id).not.toBe(first.data.id)

      const stopped = yield* Effect.promise(() => fetch(route, { method: "DELETE", headers }))
      expect(stopped.status).toBe(200)
      expect(yield* Effect.promise(() => stopped.json())).toBe(1)
    })

  if (process.platform === "win32") {
    cliIt.skip("reconciles terminals after a hard server crash and creates a replacement", terminalRestart, 60_000)
  } else {
    cliIt.live("reconciles terminals after a hard server crash and creates a replacement", terminalRestart, 60_000)
  }

  cliIt.live(
    "kills the subprocess on scope close",
    ({ novaclaw }) =>
      Effect.gen(function* () {
        // Inner scope so we can observe `.exited` resolving after it closes.
        const exitedPromise = yield* Effect.scoped(
          Effect.gen(function* () {
            const server = yield* novaclaw.serve()
            // Capture the Promise, not the resolved value — scope closes after
            // this gen returns, at which point the finalizer kills the child.
            return server.exited
          }),
        )
        // After scope close: finalizer fired, process must have exited.
        const code = yield* Effect.promise(() => exitedPromise)
        // Bun reports the exit code; SIGTERM-killed processes return non-null
        // (typically 143 on POSIX). We just require resolution within a sane
        // window — anything else means the kill didn't take.
        expect(typeof code === "number" || code === null).toBe(true)
      }),
    60_000,
  )
})
