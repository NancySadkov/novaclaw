import { afterEach, describe, expect, test } from "bun:test"
import { EventV2 } from "@novaclaw/core/event"
import { Location } from "@novaclaw/core/location"
import { Context, Schema } from "effect"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

const context = Context.empty() as Context.Context<unknown>

function request(route: string, directory: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set("x-novaclaw-directory", directory)
  return HttpApiApp.webHandler().handler(
    new Request(`http://localhost${route}`, {
      ...init,
      headers,
    }),
    context,
  )
}

const Event = Schema.Struct({
  id: EventV2.ID,
  type: Schema.String,
  location: Schema.optional(Location.Ref),
  data: Schema.Unknown,
})

async function* eventStream(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    while (true) {
      const boundary = buffer.match(/(?:\r\n|\r|\n){2}/)
      if (!boundary || boundary.index === undefined) {
        const value = await reader.read()
        if (value.done) return
        buffer += decoder.decode(value.value, { stream: true })
        continue
      }

      const record = buffer.slice(0, boundary.index)
      buffer = buffer.slice(boundary.index + boundary[0].length)
      const data = record
        .split(/\r\n|\r|\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
      if (data.length) yield Schema.decodeUnknownSync(Event)(JSON.parse(data.join("\n")))
    }
  } finally {
    try {
      await reader.cancel()
    } finally {
      reader.releaseLock()
    }
  }
}

async function readEvent(reader: AsyncIterator<typeof Event.Type>) {
  const value = await reader.next()
  if (value.done) throw new Error("event stream closed")
  return value.value
}

async function readEventType(reader: AsyncIterator<typeof Event.Type>, type: string) {
  for (let index = 0; index < 20; index++) {
    const event = await readEvent(reader)
    if (event.type === type) return event
  }
  throw new Error(`timed out waiting for ${type}`)
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("v2 location HttpApi", () => {
  test("decodes EventV2 location refs without resolved project metadata", () => {
    expect(
      Schema.decodeUnknownSync(Event)({
        id: "evt_test",
        type: "file.watcher.updated",
        location: { directory: "/tmp/project" },
        data: {},
      }),
    ).toMatchObject({ location: { directory: "/tmp/project" } })
  })

  test("returns command and skill snapshots with resolved locations", async () => {
    await using tmp = await tmpdir({ git: true })

    for (const route of ["/api/command", "/api/skill"]) {
      const response = await request(route, tmp.path)
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        location: { directory: string; root: string; origin: string }
        data: unknown
      }
      expect(body.data).toBeArray()
      expect(body.location.directory).toBe(tmp.path)
      // T2 (notes/entities.md): a project is not an entity. This asserted `location.project.id`
      // until 2026-08-06 — a field `Location.Info` has not had since the kill — so it failed
      // deterministically and was carried in the baseline as Windows flakiness for the whole
      // migration. The current contract is the two DERIVED substrate attributes.
      expect(body.location.root).toBeTruthy()
      expect(body.location.origin).toBeTruthy()
    }
  })

  test("🔴 a create with NO location in the payload lands at the REQUESTED directory", async () => {
    // Ruling 1 for the 2026-08-07 fix. `session.create` declared no middleware — every session-scoped
    // endpoint uses `sessionLocationMiddleware`, which needs a session that a create does not have yet
    // — so the handler had no `Location.Service` and fell back to `process.cwd()`. Sessions created
    // without an explicit location were filed under the SERVER PROCESS's directory, while `list`
    // honoured the request's, so a create-then-list in one breath returned nothing.
    //
    // ⚠️ The omitted `location` is the whole point of this test: passing one exercises the path that
    // was never broken. And the assertion must compare against the REQUESTED directory rather than
    // "not cwd" — under bun the test process's cwd is `packages/novaclaw`, so a weaker check would
    // pass on any tmpdir and go green again the moment the fallback returned.
    await using tmp = await tmpdir({ git: true })
    const response = await request("/api/session", tmp.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "build", title: "no location supplied" }),
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: { location: { directory: string } } }
    expect(body.data.location.directory).toBe(tmp.path)
  })

  test("streams native EventV2 payloads across locations", async () => {
    await using subscriber = await tmpdir({ git: true })
    await using publisher = await tmpdir({ git: true })
    const response = await request("/api/event", subscriber.path)
    const reader = eventStream(response.body!)
    const connected = await readEvent(reader)
    expect(connected.type).toBe("server.connected")
    expect(connected.location).toBeUndefined()

    const created = await request("/api/session", publisher.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "build", location: { directory: publisher.path } }),
    })
    expect(created.status).toBe(200)
    expect(await readEventType(reader, "session.created")).toMatchObject({
      type: "session.created",
      location: { directory: publisher.path },
      data: { sessionID: expect.any(String) },
    })
    await reader.return(undefined)
  })
})
