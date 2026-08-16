import { afterEach, describe, expect, test } from "bun:test"
import { ConfigProvider, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { CommunityPeerPaths } from "../../src/server/routes/instance/httpapi/groups/community"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

/**
 * Community — instances that ANSWER (`notes/spec/honesty-ledger.md` §4d).
 *
 * 🔴 The one path that spends the owner's TOKENS on somebody they have never met, so what is pinned
 * here is the state every install is in the moment this ships: OFF, and saying so.
 *
 * ⚠️ No model runs in these. That is the point — a refusal must be decided before anything is
 * resolved or called, or a stranger gets work from us for free on a capability nobody enabled.
 */

function app() {
  return HttpRouter.toWebHandler(
    HttpApiApp.routes.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({})))),
    { disableLogger: true },
  ).handler
}

const ask = (handler: ReturnType<typeof app>, directory: string, body: unknown) => {
  const payload = JSON.stringify(body)
  return handler(
    // ⚠️ The app CONTEXT is the second argument — the same way the route-auth suite drives it.
    new Request(`http://localhost${CommunityPeerPaths.ask}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-novaclaw-directory": directory,
        /**
         * ⚠️ Set EXPLICITLY. The peer-body middleware refuses a POST with no `content-length`,
         * because the check has to happen before the allocation it exists to prevent — and a
         * constructed `Request` does not populate it. Without this the endpoint answers 413 and the
         * test reads as a product failure rather than a fixture that never knocked properly.
         */
        "content-length": String(new TextEncoder().encode(payload).length),
      },
      body: payload,
    }),
    HttpApiApp.context,
  )
}

describe("asking this instance a question", () => {
  afterEach(disposeAllInstances)

  test("🔴 a fresh install's peer door is SHUT, before any of this is reached", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false } })
    const response = await ask(app(), tmp.path, { asker: "nid_someone", question: "what happened today?" })

    /**
     * ⚠️ 503, not a refusal body — and this is the ordering I got wrong when writing the test.
     * The peer door is closed for an instance that has not joined, so `ask` is unreachable before the
     * answering gate is consulted at all. The handler's own `not-joined` branch is therefore defence
     * in depth rather than the live path, which is the right way round: the cheapest refusal wins.
     */
    expect(response.status).toBe(503)
  })

  test("🔴 JOINED but not answering: refused, and NAMED", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, community: { consented: true } } })
    const response = await ask(app(), tmp.path, { asker: "nid_someone", question: "what happened today?" })

    expect(response.status).toBe(200)
    const body = (await response.json()) as { answer?: string; refused?: string }

    /**
     * 🔴 A NAMED refusal, not silence and not an empty answer. An asker told only "no" cannot tell a
     * closed door from a spent budget, and an empty `answer` would read as "this instance knows
     * nothing" — a claim about the world rather than about our settings.
     */
    expect(body.refused).toBe("not-answering")
    expect(body.answer).toBeUndefined()
  })

  test("⚠️ a malformed question is refused by the SCHEMA, before any of it runs", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, community: { consented: true } } })
    // No asker: the budget cannot be shared out without knowing who is spending it, so this is not a
    // field the handler may default.
    const response = await ask(app(), tmp.path, { question: "and who am I?" })
    expect(response.status).toBe(400)
  })
})
