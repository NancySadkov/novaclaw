import { describe, expect } from "bun:test"
import { Effect, Layer, Queue } from "effect"
import { existsSync, unlinkSync } from "node:fs"
import path from "node:path"
import { Flag } from "@novaclaw/core/flag/flag"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { Worktree } from "@/worktree"
import { Server } from "../../src/server/server"
import { ExperimentalPaths } from "../../src/server/routes/instance/httpapi/groups/experimental"
import { WorkspacePaths } from "../../src/server/routes/instance/httpapi/groups/workspace"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const stateLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const original = {
      NOVACLAW_EXPERIMENTAL_WORKSPACES: Flag.NOVACLAW_EXPERIMENTAL_WORKSPACES,
    }

    Flag.NOVACLAW_EXPERIMENTAL_WORKSPACES = true

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        Flag.NOVACLAW_EXPERIMENTAL_WORKSPACES = original.NOVACLAW_EXPERIMENTAL_WORKSPACES
        await resetDatabase()
      }),
    )
  }),
)

const it = testEffect(stateLayer)
// 🔴 **Un-skipped on win32 2026-08-07.** The skip had no recorded reason and was hiding a test that
// called `/project/current` — a route the project-entity kill removed — so it failed on EVERY
// platform and the skip was the only thing keeping that off the gate. That test is gone (its scenario
// cannot occur: the workspace adapter passes no start command) and the property it cared about moved
// to the direct create, which now passes a real slow `startCommand`.
const worktreeTest = it.instance
type TestServer = ReturnType<typeof Server.Default>["app"]
type CreatedWorktree = { directory: string }
type ScopedWorktree = { directory: string; body: CreatedWorktree; ready: Effect.Effect<void, Error> }
type CreatedWorktreeWithReady = CreatedWorktree & { ready: Effect.Effect<void, Error> }

function serverScoped() {
  return Effect.sync(() => Server.Default().app)
}

function request(server: TestServer, input: string, init?: RequestInit) {
  return Effect.promise(() => Promise.resolve(server.request(input, init)))
}

function withRequestTimeout(effect: Effect.Effect<Response>, label: string, ms = 5_000) {
  return effect.pipe(
    Effect.timeoutOrElse({
      duration: `${ms} millis`,
      orElse: () => Effect.fail(new Error(`${label} timed out after ${ms}ms`)),
    }),
  )
}

function json<T>(response: Response) {
  return Effect.promise(() => response.json() as Promise<T>)
}

function waitForFile(file: string, ms = 5_000) {
  return Effect.promise(async () => {
    const deadline = Date.now() + ms
    while (!existsSync(file)) {
      if (Date.now() >= deadline) throw new Error(`timed out waiting for file: ${file}`)
      await Bun.sleep(25)
    }
  })
}

function readyWatcher() {
  return Effect.gen(function* () {
    const events = yield* Queue.bounded<GlobalEvent>(1)
    const on = (event: GlobalEvent) => {
      if (event.payload.type === Worktree.Event.Ready.type) Queue.offerUnsafe(events, event)
    }

    GlobalBus.on("event", on)
    yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", on)))

    return (directory: string) =>
      Effect.gen(function* () {
        while (true) {
          const event = yield* Queue.take(events)
          if (event.directory === directory) return
        }
      }).pipe(
        Effect.timeoutOrElse({
          duration: "10 seconds",
          orElse: () => Effect.fail(new Error(`timed out waiting for worktree.ready: ${directory}`)),
        }),
      )
  })
}

function removeCreatedWorktree(input: {
  server: TestServer
  rootDirectory: string
  worktreeDirectory: string
  ready: Effect.Effect<void, Error>
}) {
  return Effect.gen(function* () {
    yield* input.ready.pipe(Effect.timeout("1 second"), Effect.ignore)
    yield* Effect.promise(() => disposeAllInstances()).pipe(Effect.ignore)

    const removed = yield* request(
      input.server,
      `${ExperimentalPaths.worktree}?directory=${encodeURIComponent(input.rootDirectory)}`,
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ directory: input.worktreeDirectory }),
      },
    )
    if (removed.status !== 200) {
      const message = yield* Effect.promise(() => removed.text())
      throw new Error(`failed to remove worktree: ${removed.status} ${message}`)
    }
    const ok = yield* json<boolean>(removed)
    if (!ok) throw new Error(`failed to remove worktree ${input.worktreeDirectory}`)
  })
}

function createWorktreeScoped(input: {
  server: TestServer
  directory: string
  path: string
  init: RequestInit
  timeoutLabel: string
  timeoutMs?: number
}) {
  return Effect.acquireRelease(
    Effect.gen(function* () {
      const waitReady = yield* readyWatcher()
      const response = yield* withRequestTimeout(
        request(input.server, input.path, input.init),
        input.timeoutLabel,
        input.timeoutMs,
      )
      if (response.status !== 200) {
        const message = yield* Effect.promise(() => response.text())
        throw new Error(`${input.timeoutLabel} failed: ${response.status} ${message}`)
      }
      expect(response.status).toBe(200)
      const body = yield* json<CreatedWorktree>(response)
      const ready = yield* Effect.cached(waitReady(body.directory))
      return { directory: body.directory, body, ready } satisfies ScopedWorktree
    }),
    (created) =>
      removeCreatedWorktree({
        server: input.server,
        rootDirectory: input.directory,
        worktreeDirectory: created.directory,
        ready: created.ready,
      }).pipe(Effect.orDie),
  ).pipe(
    Effect.map(
      (created) => ({ ...created.body, ready: created.ready }) satisfies CreatedWorktreeWithReady,
    ),
  )
}

// `setProjectStartCommand` lived here until 2026-08-07. It read `/project/current` and PATCHed
// `/project/:id {commands:{start}}` — a route AND a concept the T2/T3 project-entity kill removed, so
// it 404'd and the whole file was skipped on win32, which is the only reason nobody saw it.
//
// ⚠️ The test it served ("workspace worktree create returns without waiting for project start
// command") is deleted rather than repointed: the workspace adapter calls `createFromInfo(info)` with
// NO start command, so that path cannot have one to wait for. The property it cared about now lives
// on the direct create above, which passes a real slow `startCommand` — the only surface where a
// start command still exists.

describe("worktree endpoint reproduction", () => {
  worktreeTest(
    "direct HttpApi worktree create returns without waiting for boot",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const server = yield* serverScoped()
        const marker = ".novaclaw-started"
        const startCommand =
          process.platform === "win32"
            ? `echo started>${marker} && ping 127.0.0.1 -n 3 >nul`
            : `touch ${marker} && sleep 2`

        const response = yield* createWorktreeScoped({
          server,
          directory: test.directory,
          path: `${ExperimentalPaths.worktree}?directory=${encodeURIComponent(test.directory)}`,
          init: {
            method: "POST",
            headers: { "content-type": "application/json" },
            // 🔴 A SLOW start command, because that is what "without waiting for boot" is ABOUT.
            // This used to post `{}` — no start command at all — so it asserted that a create with
            // nothing to wait for does not wait. The scenario moved here on 2026-08-07: `startCommand`
            // on `CreateInput` is the only way a start command reaches a worktree now.
            body: JSON.stringify({
              startCommand,
            }),
          },
          timeoutLabel: "direct worktree create",
        })

        expect(typeof response.directory).toBe("string")
        const finished = path.join(response.directory, marker)
        // The response arrives before the slow command even starts. Unlike an elapsed-time ceiling,
        // this remains about endpoint semantics when the full test gate saturates the machine. Then
        // prove the detached boot really reaches the command before allowing scoped cleanup to run.
        expect(existsSync(finished)).toBe(false)
        yield* response.ready
        yield* waitForFile(finished)
        unlinkSync(finished)
        yield* Effect.promise(() => Bun.sleep(2_100))
      }),
    { git: true },
    // ⚠️ Its OWN timeout, because this test cannot fit in bun's 5 s default and must not depend on
    // the runner's `--timeout=15000` to be true. It waits on a deliberately slow start command —
    // that wait IS the subject, "returns without waiting for boot" — so `bun test <this file>`
    // failed while the gate stayed green, which is the worst way for a test to be red: only when
    // someone checks it by hand, and never where it would be noticed.
    15_000,
  )

  worktreeTest(
    "direct HttpApi worktree create accepts missing body",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const server = yield* serverScoped()

        const response = yield* createWorktreeScoped({
          server,
          directory: test.directory,
          path: `${ExperimentalPaths.worktree}?directory=${encodeURIComponent(test.directory)}`,
          init: { method: "POST", headers: { "content-type": "application/json" } },
          timeoutLabel: "direct worktree create without body",
        })

        expect(response).toMatchObject({ directory: expect.any(String) })
      }),
    { git: true },
  )

  worktreeTest(
    "direct HttpApi worktree create accepts missing content type and body",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const server = yield* serverScoped()

        const response = yield* createWorktreeScoped({
          server,
          directory: test.directory,
          path: `${ExperimentalPaths.worktree}?directory=${encodeURIComponent(test.directory)}`,
          init: { method: "POST" },
          timeoutLabel: "direct worktree create without content type or body",
        })

        expect(response).toMatchObject({ directory: expect.any(String) })
      }),
    { git: true },
  )

  worktreeTest(
    "direct HttpApi worktree create rejects explicit null payload",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const server = yield* serverScoped()

        const response = yield* request(
          server,
          `${ExperimentalPaths.worktree}?directory=${encodeURIComponent(test.directory)}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "null",
          },
        )

        expect(response.status).toBe(400)
      }),
    { git: true },
  )

  worktreeTest(
    "workspace worktree create does not hang",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const server = yield* serverScoped()

        const response = yield* createWorktreeScoped({
          server,
          directory: test.directory,
          path: `${WorkspacePaths.list}?directory=${encodeURIComponent(test.directory)}`,
          init: {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ type: "worktree", branch: null }),
          },
          timeoutLabel: "workspace worktree create",
          timeoutMs: 8_000,
        })

        expect(response).toMatchObject({
          type: "worktree",
          directory: expect.any(String),
        })
      }),
    { git: true },
  )
})
