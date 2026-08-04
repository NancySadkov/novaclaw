import { afterEach, describe, expect, test } from "bun:test"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances } from "../fixture/fixture"

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

function app() {
  return Server.Default().app
}

// Generated clients drop an all-default JSON body entirely (buildClientParams →
// stripEmptySlots serializes `{}` to NO body), so every all-optional payload endpoint
// 400s "Expected object, got undefined" on a zero-field call. session.create is
// all-optional and is hit by the flagship flow whenever the composer stages zero
// overrides (all-default settings). emptyJsonBodyLayer patches the transport: an
// empty body on a JSON mutation request decodes as `{}`.
describe("empty JSON body middleware", () => {
  test("POST /api/session with content-length 0 and JSON content-type creates a session", async () => {
    const response = await app().request("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "0" },
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as { data?: { id?: string } }
    expect(body.data?.id).toStartWith("ses_")
  })

  test("POST /api/session with a literal {} body still works", async () => {
    const response = await app().request("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as { data?: { id?: string } }
    expect(body.data?.id).toStartWith("ses_")
  })

  test("non-JSON empty POST is left alone (still rejected by the payload decoder)", async () => {
    const response = await app().request("/api/session", {
      method: "POST",
      headers: { "content-length": "0" },
    })

    expect(response.status).toBe(400)
  })
})
