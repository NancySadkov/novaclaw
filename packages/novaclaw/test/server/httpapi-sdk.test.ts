import { afterEach, describe, expect } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import type * as Scope from "effect/Scope"
import { HttpServer } from "effect/unstable/http"
import { ChildProcessSpawner } from "effect/unstable/process"
import { FSUtil } from "@novaclaw/core/fs-util"
import { CrossSpawnSpawner } from "@novaclaw/core/cross-spawn-spawner"
import { Flag } from "@novaclaw/core/flag/flag"
import { createNovaclawClient } from "@novaclaw/sdk/v2"
import { validateSession } from "../../src/cli/validate-session"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"

import type { Config } from "@/config/config"
import { errorMessage } from "../../src/util/error"
import path from "path"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { Database } from "@novaclaw/core/database/database"
import { httpApiLayer } from "./httpapi-layer"

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const it = testEffect(
  Layer.mergeAll(
    FSUtil.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    InstanceStore.defaultLayer.pipe(Layer.provide(noopBootstrap)),
    Database.defaultLayer,
    httpApiLayer,
  ),
)

const original = {
  NOVACLAW_SERVER_PASSWORD: Flag.NOVACLAW_SERVER_PASSWORD,
  NOVACLAW_SERVER_USERNAME: Flag.NOVACLAW_SERVER_USERNAME,
}

type ServerPath = "default" | "raw"
type Sdk = ReturnType<typeof createNovaclawClient>
type SdkResult = { response: Response; data?: unknown; error?: unknown }
type Captured = { status: number; data?: unknown; error?: unknown }
type ProjectFixture = { sdk: Sdk; directory: string }
type TestServices =
  | FSUtil.Service
  | ChildProcessSpawner.ChildProcessSpawner
  | InstanceStore.Service
  | HttpServer.HttpServer
type TestScope = Scope.Scope | TestServices

function client(
  serverPath: ServerPath,
  directory?: string,
  input?: {
    password?: string
    username?: string
    headers?: Record<string, string>
    workspaceID?: string
    onRequest?: (request: Request) => void
  },
) {
  return serverFetch(serverPath, input).pipe(
    Effect.map((fetch) =>
      createNovaclawClient({
        baseUrl: "http://localhost",
        directory,
        experimental_workspaceID: input?.workspaceID,
        headers: input?.headers,
        fetch,
      }),
    ),
  )
}

function serverFetch(
  serverPath: ServerPath,
  input?: { password?: string; username?: string; onRequest?: (request: Request) => void },
) {
  return HttpServer.HttpServer.use((server) =>
    Effect.sync(() => {
      void serverPath
      Flag.NOVACLAW_SERVER_PASSWORD = input?.password
      Flag.NOVACLAW_SERVER_USERNAME = input?.username
      const baseUrl = HttpServer.formatAddress(server.address)
      return Object.assign(
        async (request: RequestInfo | URL, init?: RequestInit) => {
          const source = request instanceof Request ? request : new Request(request, init)
          input?.onRequest?.(source)
          const url = new URL(source.url)
          return globalThis.fetch(new Request(new URL(`${url.pathname}${url.search}`, baseUrl), source))
        },
        { preconnect: globalThis.fetch.preconnect },
      ) satisfies typeof globalThis.fetch
    }),
  )
}

function authorization(username: string, password: string) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

function call<T>(request: () => Promise<T>) {
  return Effect.promise(request)
}

function capture(request: () => Promise<SdkResult>) {
  return call(request).pipe(
    Effect.map((result) => ({
      status: result.response.status,
      data: result.data,
      error: result.error,
    })),
  )
}

function captureThrown(request: () => Promise<unknown>) {
  return call(async () => {
    try {
      await request()
    } catch (error) {
      return error
    }
  })
}

function expectStatus(request: () => Promise<{ response: Response }>, status: number) {
  return call(request).pipe(
    Effect.tap((result) => Effect.sync(() => expect(result.response.status).toBe(status))),
    Effect.asVoid,
  )
}

function firstEvent(open: (signal: AbortSignal) => Promise<{ stream: AsyncIterator<unknown> }>) {
  return Effect.acquireRelease(
    Effect.sync(() => new AbortController()),
    (controller) => Effect.sync(() => controller.abort()),
  ).pipe(
    Effect.flatMap((controller) =>
      Effect.acquireRelease(
        call(() => open(controller.signal)),
        (events) => call(async () => void (await events.stream.return?.(undefined))).pipe(Effect.ignore),
      ).pipe(
        Effect.flatMap((events) =>
          call(() => events.stream.next()).pipe(
            Effect.timeoutOrElse({
              duration: "1 second",
              orElse: () => Effect.fail(new Error("timed out waiting for SDK event")),
            }),
          ),
        ),
        Effect.map((result) => result.value),
      ),
    ),
  )
}

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {}
}

function array(value: unknown) {
  return Array.isArray(value) ? value : []
}

function statuses(input: Record<string, Captured>) {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, value.status]))
}

function sessionTitles(value: unknown) {
  return array(value)
    .map((item) => record(item).title)
    .filter((title): title is string => typeof title === "string")
    .sort()
}

function resetState() {
  return Effect.promise(async () => {
    await disposeAllInstances()
    await resetDatabase()
  })
}

function httpapi<A, E>(name: string, effect: Effect.Effect<A, E, TestScope>) {
  it.live(name, effect)
}

function httpapiInstance<A, E>(
  name: string,
  options: {
    serverPath: ServerPath
    git?: boolean
    config?: Partial<Config.Info>
    setup?: (dir: string) => Effect.Effect<void, E, TestServices>
  },
  run: (input: ProjectFixture) => Effect.Effect<A, E, TestScope>,
) {
  it.instance(
    name,
    Effect.gen(function* () {
      const instance = yield* TestInstance
      yield* options.setup?.(instance.directory) ?? Effect.void
      return yield* run({ sdk: yield* client(options.serverPath, instance.directory), directory: instance.directory })
    }),
    { git: options.git ?? true, config: { formatter: false, ...options.config } },
  )
}

function serverPathParity<A, E>(name: string, scenario: (serverPath: ServerPath) => Effect.Effect<A, E, TestScope>) {
  it.live(name, scenario("raw"))
}

function withProject<A, E, E2 = never>(
  serverPath: ServerPath,
  options: {
    git?: boolean
    config?: Partial<Config.Info>
    setup?: (dir: string) => Effect.Effect<void, E2, TestServices>
  },
  run: (input: ProjectFixture) => Effect.Effect<A, E, TestScope>,
) {
  return Effect.gen(function* () {
    const directory = yield* tmpdirScoped({
      git: options.git ?? false,
      config: { formatter: false, ...options.config },
    })
    yield* options.setup?.(directory) ?? Effect.void
    return yield* run({ sdk: yield* client(serverPath, directory), directory })
  })
}

function withStandardProject<A, E>(
  serverPath: ServerPath,
  run: (input: ProjectFixture) => Effect.Effect<A, E, TestScope>,
) {
  return withProject(serverPath, { setup: writeStandardFiles }, run)
}

function writeStandardFiles(dir: string) {
  return FSUtil.Service.use((fs) =>
    Effect.all([
      fs.writeWithDirs(path.join(dir, "hello.txt"), "hello"),
      fs.writeWithDirs(path.join(dir, "needle.ts"), "export const needle = 'sdk-parity'\n"),
    ]).pipe(Effect.asVoid),
  )
}

afterEach(async () => {
  Flag.NOVACLAW_SERVER_PASSWORD = original.NOVACLAW_SERVER_PASSWORD
  Flag.NOVACLAW_SERVER_USERNAME = original.NOVACLAW_SERVER_USERNAME
  await disposeAllInstances()
  await resetDatabase()
})

describe("HttpApi SDK", () => {
  httpapi(
    "uses the generated SDK for global and control routes",
    Effect.gen(function* () {
      const sdk = yield* client("raw")
      const health = yield* call(() => sdk.global.health())
      const log = yield* call(() => sdk.app.log({ service: "httpapi-sdk-test", level: "info", message: "hello" }))

      expect(health.response.status).toBe(200)
      expect(health.data).toMatchObject({ healthy: true })
      expect(yield* firstEvent((signal) => sdk.global.event({ signal }))).toMatchObject({
        payload: { type: "server.connected" },
      })
      expect(log.response.status).toBe(200)
      expect(log.data).toBe(true)
      yield* expectStatus(() => sdk.auth.set({ providerID: "test" }), 400)
    }),
  )

  httpapiInstance(
    "uses the generated SDK for safe instance routes",
    { serverPath: "raw", git: false, setup: writeStandardFiles },
    ({ sdk }) =>
      Effect.gen(function* () {
        const file = yield* call(() => sdk.file.read({ path: "hello.txt" }))
        const session = yield* call(() => sdk.v2.session.create({ title: "sdk" }))
        const listed = yield* call(() => sdk.v2.session.list({ roots: true, limit: 10 }))

        expect(file.response.status).toBe(200)
        expect(file.data).toMatchObject({ content: "hello" })
        expect(session.response.status).toBe(200)
        expect(session.data?.data).toMatchObject({ title: "sdk" })
        expect(listed.response.status).toBe(200)
        expect(listed.data?.data.map((item) => item.id)).toContain(session.data?.data.id)

        yield* Effect.all([
          expectStatus(() => sdk.config.get(), 200),
          expectStatus(() => sdk.config.providers(), 200),
          expectStatus(() => sdk.find.files({ query: "hello", limit: 10 }), 200),
        ])
      }),
  )

  httpapi(
    "routes configured SDK directory and workspace for v2 location GETs",
    withProject("raw", { setup: writeStandardFiles }, ({ directory }) =>
      Effect.gen(function* () {
        const workspaceID = "wrk_sdk"
        let request: Request | undefined
        const sdk = yield* client("raw", directory, {
          workspaceID,
          onRequest: (value) => (request = value),
        })
        const found = yield* pollWithTimeout(
          call(() => sdk.v2.fs.find({ query: "hello", type: "file" })).pipe(
            Effect.map((result) => (result.data?.data.length ? result : undefined)),
          ),
          "SDK file search index was not ready",
        )
        const url = new URL(request!.url)

        expect(found.response.status).toBe(200)
        expect(found.data).toMatchObject({ data: [{ path: "hello.txt", type: "file" }] })
        expect(url.searchParams.get("directory")).toBe(directory)
        expect(url.searchParams.get("workspace")).toBe(workspaceID)
        expect(url.searchParams.get("location[directory]")).toBe(directory)
        expect(url.searchParams.get("location[workspace]")).toBe(workspaceID)
        expect(request!.headers.has("x-novaclaw-directory")).toBe(false)
        expect(request!.headers.has("x-novaclaw-workspace")).toBe(false)
      }),
    ),
  )

  serverPathParity("matches generated SDK global and control behavior", (serverPath) =>
    Effect.gen(function* () {
      const sdk = yield* client(serverPath)
      const health = yield* capture(() => sdk.global.health())
      const log = yield* capture(() => sdk.app.log({ service: "sdk-parity", level: "info", message: "hello" }))
      const invalidAuth = yield* capture(() => sdk.auth.set({ providerID: "test" }))

      return {
        statuses: statuses({ health, log, invalidAuth }),
        health: record(health.data).healthy,
        log: log.data,
      }
    }),
  )

  serverPathParity("matches generated SDK global event stream", (serverPath) =>
    Effect.gen(function* () {
      const sdk = yield* client(serverPath)
      const event = yield* firstEvent((signal) => sdk.global.event({ signal }))
      return { type: record(record(event).payload).type }
    }),
  )

  serverPathParity("matches generated SDK instance event stream", (serverPath) =>
    withStandardProject(serverPath, ({ sdk }) =>
      firstEvent((signal) => sdk.event.subscribe(undefined, { signal })).pipe(
        Effect.map((event) => ({ type: record(record(event).payload).type })),
      ),
    ),
  )

  serverPathParity("matches generated SDK missing session errors", (serverPath) =>
    withStandardProject(serverPath, ({ sdk }) =>
      Effect.gen(function* () {
        const sessionID = "ses_missing"
        const expected = {
          name: "NotFoundError",
          data: { message: `Session not found: ${sessionID}` },
        }
        const missing = yield* capture(() => sdk.v2.session.get({ sessionID }))
        const thrown = yield* captureThrown(() => sdk.v2.session.get({ sessionID }, { throwOnError: true }))

        // Result-tuple path: error body is preserved as-is so existing
        // consumers reading `result.error.name` / `JSON.stringify(error)`
        // keep working byte-for-byte.
        expect(missing.error).toEqual(expected)
        // throwOnError path: SDK wraps the body in a real Error with the
        // server's message, with the original parsed body preserved under
        // `.cause.body`.
        expect(thrown).toBeInstanceOf(Error)
        expect((thrown as Error).message).toBe(expected.data.message)
        expect(((thrown as Error).cause as { body: unknown }).body).toEqual(expected)
        return {
          status: missing.status,
          error: missing.error,
          thrown,
        }
      }),
    ),
  )

  serverPathParity("formats missing session validation errors for -s", (serverPath) =>
    withStandardProject(serverPath, ({ directory }) =>
      Effect.gen(function* () {
        const sessionID = "ses_206f84f18ffeZ6hhD7pFYAiW5T"
        const fetch = yield* serverFetch(serverPath)
        const thrown = yield* captureThrown(() =>
          validateSession({
            url: "http://localhost",
            directory,
            sessionID,
            fetch,
          }),
        )
        expect(errorMessage(thrown)).toBe(`Session not found: ${sessionID}`)
        return errorMessage(thrown)
      }),
    ),
  )

  httpapiInstance(
    "uses generated SDK basic auth behavior",
    { serverPath: "raw", setup: writeStandardFiles },
    ({ directory }) =>
      Effect.gen(function* () {
        const missingSdk = yield* client("raw", directory, { password: "secret" })
        const missing = yield* capture(() => missingSdk.file.read({ path: "hello.txt" }))
        const badSdk = yield* client("raw", directory, {
          password: "secret",
          headers: { authorization: authorization("novaclaw", "wrong") },
        })
        const bad = yield* capture(() => badSdk.file.read({ path: "hello.txt" }))
        const goodSdk = yield* client("raw", directory, {
          password: "secret",
          headers: { authorization: authorization("novaclaw", "secret") },
        })
        const good = yield* capture(() => goodSdk.file.read({ path: "hello.txt" }))

        return {
          statuses: statuses({ missing, bad, good }),
          content: record(good.data).content,
        }
      }),
  )

  serverPathParity("matches generated SDK instance read routes", (serverPath) =>
    withProject(serverPath, { git: true, setup: writeStandardFiles }, ({ sdk, directory }) =>
      Effect.gen(function* () {
        const paths = yield* capture(() => sdk.path.get())
        const config = yield* capture(() => sdk.config.get())
        const providers = yield* capture(() => sdk.config.providers())
        const file = yield* capture(() => sdk.file.read({ path: "hello.txt" }))
        const files = yield* capture(() => sdk.file.list({ path: "." }))
        const fileStatus = yield* capture(() => sdk.file.status())
        const findFiles = yield* capture(() => sdk.find.files({ query: "hello", limit: 10 }))
        const findText = yield* capture(() => sdk.find.text({ pattern: "sdk-parity" }))
        const agents = yield* capture(() => sdk.app.agents())
        const skills = yield* capture(() => sdk.app.skills())
        const tools = yield* capture(() => sdk.tool.ids())
        const vcs = yield* capture(() => sdk.vcs.get())
        const formatter = yield* capture(() => sdk.formatter.status())

        return {
          statuses: statuses({
            paths,
            config,
            providers,
            file,
            files,
            fileStatus,
            findFiles,
            findText,
            agents,
            skills,
            tools,
            vcs,
            formatter,
          }),
          paths: { directorySelected: record(paths.data).directory === directory },
          file: record(file.data).content,
          foundFile: JSON.stringify(findFiles.data).includes("hello.txt"),
          foundText: JSON.stringify(findText.data ?? null).includes("sdk-parity"),
          listedFile: JSON.stringify(files.data).includes("hello.txt"),
          vcs: { hasBranch: typeof record(vcs.data).branch === "string" },
        }
      }),
    ),
  )

  serverPathParity("matches generated SDK session lifecycle routes", (serverPath) =>
    withStandardProject(serverPath, ({ sdk }) =>
      Effect.gen(function* () {
        const parent = yield* capture(() => sdk.v2.session.create({ title: "parent" }))
        const parentID = String(record(parent.data).id)
        const child = yield* capture(() => sdk.v2.session.create({ title: "child", parentID }))
        const childID = String(record(child.data).id)
        const get = yield* capture(() => sdk.v2.session.get({ sessionID: parentID }))
        const update = yield* capture(() => sdk.v2.session.update({ sessionID: parentID, title: "renamed" }))
        const roots = yield* capture(() => sdk.v2.session.list({ roots: true, limit: 10 }))
        const all = yield* capture(() => sdk.v2.session.list({ roots: false, limit: 10 }))
        const children = yield* capture(() => sdk.v2.session.children({ sessionID: parentID }))
        const todo = yield* capture(() => sdk.v2.session.todo({ sessionID: parentID }))
        const status = yield* capture(() => sdk.v2.session.active())
        // F1g: the V1 session.messages route (WithParts) is gone — native transcripts are read via
        // sdk.v2.session.messages (covered by httpapi-session-v2). Session-level SDK routes remain.
        const missingGet = yield* capture(() => sdk.v2.session.get({ sessionID: "ses_missing" }))
        const deleted = yield* capture(() => sdk.v2.session.remove({ sessionID: childID }))
        const getDeleted = yield* capture(() => sdk.v2.session.get({ sessionID: childID }))

        return {
          statuses: statuses({
            parent,
            child,
            get,
            update,
            roots,
            all,
            children,
            todo,
            status,
            missingGet,
            deleted,
            getDeleted,
          }),
          getTitle: record(get.data).title,
          updatedTitle: record(update.data).title,
          rootTitles: sessionTitles(roots.data),
          allTitles: sessionTitles(all.data),
          childCount: array(children.data).length,
          todoCount: array(todo.data).length,
        }
      }),
    ),
  )

  // F1g: three SDK parity suites retired with the V1 message/part routes they exercised —
  // "session message and part routes" (messages/message/part.update/part.delete/deleteMessage),
  // "streams sync-backed part updates" (Session.updatePart → message.part.updated event), and the
  // promptAsync no-reply observation via sdk.session.messages. Native transcript reads are covered
  // by httpapi-session-v2 (sdk.v2.session.messages); promptAsync routing by the same suite's Case (a).

  // The SDK TUI parity suite retired with the TUI routes themselves (the server has no /tui
  // surface; the regenerated client rightly has no `sdk.tui`). It only ever exercised 404s.

})
