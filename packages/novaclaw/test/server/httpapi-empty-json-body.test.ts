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
  /**
   * 🔴 **These assert the MIDDLEWARE, and NC-SEC-020 made them say so properly.**
   *
   * Both used to expect a 200 and a session id. A root create with no `agent` is refused now, so they
   * would have had to become "expect 400" — and a 400 is also what a body the middleware FAILED to
   * patch produces, which would have left them passing for the opposite reason. They assert the
   * REFUSAL's own message instead: reaching the owner check at all proves the empty body decoded to
   * `{}` and arrived at the handler, which is the only thing this file is about.
   */
  const ownerRefusal = async (response: Response) => {
    expect(response.status).toBe(400)
    const body = (await response.json()) as { message?: string }
    // The handler's words, not the decoder's — see the test below for the contrast.
    expect(body.message ?? "").toContain("must name the agent")
  }

  test("POST /api/session with content-length 0 and JSON content-type reaches the handler", async () => {
    await ownerRefusal(
      await app().request("/api/session", {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": "0" },
      }),
    )
  })

  test("POST /api/session with a literal {} body reaches the handler", async () => {
    await ownerRefusal(
      await app().request("/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    )
  })

  test("a body that DOES name an agent still creates a session", async () => {
    // The other direction: the middleware is not swallowing real payloads.
    const response = await app().request("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "build" }),
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
