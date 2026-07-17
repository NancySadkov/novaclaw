import { afterEach, describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { eq } from "drizzle-orm"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { ExperimentalPaths } from "../../src/server/routes/instance/httpapi/groups/experimental"
import { SessionTable } from "@novaclaw/core/session/sql"
import { SessionSchema } from "@novaclaw/core/session/schema"
import { ProjectV2 } from "@novaclaw/core/project"
import { Database } from "@novaclaw/core/database/database"
import { AccountV2 } from "@novaclaw/core/account"
import { AccountTable } from "@novaclaw/core/account/sql"
import { Worktree } from "../../src/worktree"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(Layer.mergeAll(Database.defaultLayer, httpApiLayer))
const testWorktreeMutations = process.platform === "win32" ? it.instance.skip : it.instance

function request(path: string, directory: string, init: RequestInit = {}) {
  return requestInDirectory(path, directory, init)
}

// V1-nuke slice D: the facade create died; route tests seed rows directly.
type SeededSession = { id: SessionSchema.ID; title: string }
let seedCounter = 0
function createSession(input?: { title?: string }): Effect.Effect<SeededSession, never, Database.Service> {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const id = SessionSchema.ID.make(`ses_test${String(++seedCounter).padStart(20, "0")}`)
    const title = input?.title ?? "test"
    const now = Date.now()
    yield* db
      .insert(SessionTable)
      .values({
        id,
        slug: id,
        directory: "C:/project",
        title,
        version: "test",
        time_created: now,
        time_updated: now,
      })
      .run()
      .pipe(Effect.orDie)
    return { id, title }
  })
}

function json<T>(response: HttpClientResponse.HttpClientResponse) {
  return response.json.pipe(Effect.map((value) => value as T))
}

function waitReady(input: { directory?: string; name?: string }) {
  return Effect.gen(function* () {
    const ready = yield* Deferred.make<void>()
    const on = (event: GlobalEvent) => {
      if (event.payload.type !== Worktree.Event.Ready.type) return
      if (input.directory && event.directory !== input.directory) return
      if (input.name && event.payload.properties.name !== input.name) return
      Deferred.doneUnsafe(ready, Effect.void)
    }

    GlobalBus.on("event", on)
    yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", on)))

    return yield* Deferred.await(ready).pipe(
      Effect.timeoutOrElse({
        duration: "10 seconds",
        orElse: () => Effect.fail(new Error("timed out waiting for worktree.ready")),
      }),
    )
  })
}

function insertAccount() {
  return Effect.acquireRelease(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(AccountTable)
        .values({
          id: AccountV2.ID.make("account-test"),
          email: "test@example.com",
          url: "https://console.example.com",
          access_token: AccountV2.AccessToken.make("access"),
          refresh_token: AccountV2.RefreshToken.make("refresh"),
          time_created: Date.now(),
          time_updated: Date.now(),
        })
        .run()
        .pipe(Effect.orDie)
      return "account-test"
    }),
    (id) =>
      Database.Service.use(({ db }) =>
        db
          .delete(AccountTable)
          .where(eq(AccountTable.id, AccountV2.ID.make(id)))
          .run()
          .pipe(Effect.orDie),
      ),
  )
}

function setSessionUpdated(session: SeededSession, updated: number) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .update(SessionTable)
      .set({ time_updated: updated })
      .where(eq(SessionTable.id, session.id))
      .run()
      .pipe(Effect.orDie)
  })
}

function withCreatedWorktree(
  directory: string,
  use: (info: Worktree.Info) => Effect.Effect<void, unknown, HttpClient.HttpClient>,
) {
  const name = "api-test"
  const headers = { "content-type": "application/json" }
  return Effect.acquireUseRelease(
    Effect.gen(function* () {
      const ready = yield* waitReady({ name }).pipe(Effect.forkScoped)
      const created = yield* request(ExperimentalPaths.worktree, directory, {
        method: "POST",
        headers,
        body: JSON.stringify({ name }),
      })

      expect(created.status).toBe(200)
      const info = yield* json<Worktree.Info>(created)
      expect(info).toMatchObject({ name, branch: "novaclaw/api-test" })
      yield* Fiber.join(ready)
      return info
    }),
    use,
    (info) =>
      Effect.gen(function* () {
        const removed = yield* request(ExperimentalPaths.worktree, directory, {
          method: "DELETE",
          headers,
          body: JSON.stringify({ directory: info.directory }),
        })
        if (removed.status !== 200) return yield* Effect.fail(new Error(`failed to remove worktree: ${removed.status}`))
        const ok = yield* json<boolean>(removed)
        if (!ok) return yield* Effect.fail(new Error(`failed to remove worktree ${info.directory}`))
      }),
  )
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("experimental HttpApi", () => {
  it.instance(
    "serves read-only experimental endpoints through the default server app",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const directory = tmp.directory
        const [consoleState, consoleOrgs, toolList, toolIDs, worktrees, resources] = yield* Effect.all(
          [
            request(ExperimentalPaths.console, directory),
            request(ExperimentalPaths.consoleOrgs, directory),
            request(`${ExperimentalPaths.tool}?provider=novaclaw&model=gpt-5`, directory),
            request(ExperimentalPaths.toolIDs, directory),
            request(ExperimentalPaths.worktree, directory),
            request(ExperimentalPaths.resource, directory),
          ],
          { concurrency: "unbounded" },
        )

        expect(consoleState.status).toBe(200)
        expect(yield* json(consoleState)).toEqual({
          consoleManagedProviders: [],
          switchableOrgCount: 0,
        })

        expect(consoleOrgs.status).toBe(200)
        expect(yield* json(consoleOrgs)).toEqual({ orgs: [] })

        expect(toolList.status).toBe(200)
        expect(yield* json<unknown[]>(toolList)).toContainEqual(
          expect.objectContaining({
            id: "bash",
            description: expect.any(String),
            parameters: expect.any(Object),
          }),
        )

        expect(toolIDs.status).toBe(200)
        expect(yield* json(toolIDs)).toContain("bash")

        expect(worktrees.status).toBe(200)
        expect(yield* json(worktrees)).toEqual([])

        expect(resources.status).toBe(200)
        expect(yield* json(resources)).toEqual({})
      }),
    {
      config: {
        formatter: false,
        mcp: {
          servers: {
            demo: {
              type: "local",
              command: ["echo", "demo"],
              disabled: true,
            },
          },
        },
      },
    },
  )

  it.instance("returns declared worktree errors", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const response = yield* request(ExperimentalPaths.worktree, tmp.directory, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })

      expect(response.status).toBe(400)
      expect(yield* json(response)).toEqual({
        name: "WorktreeNotGitError",
        data: { message: "Worktrees are only supported for git projects" },
      })
    }),
  )

  it.instance(
    "serves Console org switch through the default server app",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const accountID = yield* insertAccount()
        const switched = yield* request(ExperimentalPaths.consoleSwitch, tmp.directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ accountID, orgID: "org-test" }),
        })

        expect(switched.status).toBe(200)
        expect(yield* json(switched)).toBe(true)
      }),
    { config: { formatter: false } },
  )

  // V1-nuke slice D: the global session list route died with the V1 read layer (no consumers).

  testWorktreeMutations(
    "serves worktree mutations through the default server app",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        yield* withCreatedWorktree(tmp.directory, (info) =>
          Effect.gen(function* () {
            const listed = yield* request(ExperimentalPaths.worktree, tmp.directory)
            expect(listed.status).toBe(200)
            expect(yield* json(listed)).toContain(info.directory)

            const reset = yield* request(ExperimentalPaths.worktreeReset, tmp.directory, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ directory: info.directory }),
            })

            expect(reset.status).toBe(200)
            expect(yield* json(reset)).toBe(true)
          }),
        )

        const afterRemove = yield* request(ExperimentalPaths.worktree, tmp.directory)
        expect(afterRemove.status).toBe(200)
        expect(yield* json(afterRemove)).toEqual([])
      }),
    { git: true, config: { formatter: false } },
  )
})
