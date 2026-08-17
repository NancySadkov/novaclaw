import { afterEach, describe, expect, test } from "bun:test"
import { generateKeyPairSync, sign as nodeSign } from "node:crypto"
import { CommunityAnswer } from "@novaclaw/core/community/answer"
import { CommunityConsent } from "@novaclaw/core/community/consent"
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


/** A real asker: an ed25519 identity that can sign its own question. */
const asker = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  const raw = (publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(12)
  const networkID = `nid_${raw.toString("base64url")}`
  return {
    networkID,
    ask: (question: string, at = Date.now()) => {
      const body = { asker: networkID, question, at }
      return {
        ...body,
        signature: nodeSign(null, Buffer.from(CommunityAnswer.askBytes(body)), privateKey).toString("base64url"),
      }
    },
  }
}

describe("asking this instance a question", () => {
  /**
   * 🔴 The consent gate is PROCESS-WIDE, so a test that joins must un-join after itself.
   *
   * ⚠️ Found by the guard next door, and it was my regression. This file boots an instance with
   * `consented: true`; that installs a granted gate for the whole process, and `install` DELIBERATELY
   * refuses to clobber one from empty storage — *storage that says nothing is not storage that says
   * no*. So the next test's FRESH install inherited consent, its peer door stood open, and
   * `/api/community/listed` answered 200 where a shut door must answer 503.
   *
   * ⚠️ The leak runs the wrong way round from the obvious worry: a test that grants a permission
   * weakens the ones after it, and every one of them still passes except the one that checks the
   * door is shut.
   */
  afterEach(() => CommunityConsent.resetGate())
  afterEach(disposeAllInstances)

  test("🔴 a doorman that answers NOTHING is not recorded as trusted", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, community: { consented: true } } })
    const payload = JSON.stringify({ address: "127.0.0.1:1", trust: 5 })
    const response = await app()(
      new Request("http://localhost/api/community/doorman", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-novaclaw-directory": tmp.path,
          "content-length": String(new TextEncoder().encode(payload).length),
        },
        body: payload,
      }),
      HttpApiApp.context,
    )

    /**
     * 🔴 A trust rating is a statement about a PERSON, so there must be a person.
     *
     * ⚠️ The tempting shortcut is to record the address with its rating and attach an identity
     * later — and it is wrong, because an address can be reassigned to somebody else, and the
     * user's sentence would silently transfer with it. Nothing answered here, so there is nobody to
     * trust and nothing is written.
     */
    expect(response.status).toBe(200)
    const body = (await response.json()) as { found: boolean; networkID?: string }
    expect(body.found).toBe(false)
    expect(body.networkID).toBeUndefined()
  })

  test("🔴 a fresh install's peer door is SHUT, before any of this is reached", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false } })
    const response = await ask(app(), tmp.path, asker().ask("what happened today?"))

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
    const response = await ask(app(), tmp.path, asker().ask("what happened today?"))

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

  test("🔴 a BLOCKED asker is refused, and cannot tell that it was blocked", async () => {
    /**
     * 🔴 The checklist's inbound rule 4 — *"check blocking if the operation attributes anything to
     * an author, and check it at INGRESS"* — applied to the one door that costs the user MONEY.
     *
     * A blocked peer could not reach this user in a room or by direct message, and could still make
     * them spend tokens answering it. The consent screen says *"you can block people, and that is the
     * only power anyone has here"*, which was untrue of exactly the door where it mattered most.
     */
    const stranger = asker()
    await using tmp = await tmpdir({
      git: true,
      config: { formatter: false, community: { consented: true, answers: { enabled: true } } },
    })
    const handler = app()

    /**
     * ⚠️ ADDED first, then blocked — because `setBlocked` UPDATES a contact row and does nothing
     * when there is none. That is worth knowing on its own: a stranger who has never been added
     * cannot be blocked at all, so the user's "only power" currently requires adding the person you
     * want nothing to do with. Recorded in the spec; out of scope for this door.
     */
    const post = (route: string, body: unknown) =>
      handler(
        new Request(`http://localhost${route}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-novaclaw-directory": tmp.path,
            "content-length": String(new TextEncoder().encode(JSON.stringify(body)).length),
          },
          body: JSON.stringify(body),
        }),
        HttpApiApp.context,
      )

    const added = await post("/api/community/contact", { networkID: stranger.networkID })
    expect(added.status, "the fixture must be able to add a contact").toBe(200)

    // Blocked through the user's own door, which is the only way anything becomes blocked.
    const blocking = await handler(
      new Request(`http://localhost/api/community/contact/${encodeURIComponent(stranger.networkID)}/block`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-novaclaw-directory": tmp.path,
          "content-length": String(new TextEncoder().encode(JSON.stringify({ blocked: true })).length),
        },
        body: JSON.stringify({ blocked: true }),
      }),
      HttpApiApp.context,
    )
    expect(blocking.status, "the fixture must actually block somebody").toBe(200)

    const response = await ask(handler, tmp.path, stranger.ask("what happened today?"))
    const body = (await response.json()) as { answer?: string; refused?: string }

    expect(body.answer, "a blocked peer must not be answered").toBeUndefined()
    /**
     * ⚠️ And the refusal is INDISTINGUISHABLE from an instance that simply is not answering today.
     * The DM door drops its verdict for the same reason: a stranger must not be able to learn that
     * this user singled them out.
     */
    expect(body.refused).toBe("not-answering")
  })

  test("🔴 an UNSIGNED ask is refused — `asker` is not a field you may simply claim", async () => {
    /**
     * ⚠️ Answering must be ON for this to test anything. The handler refuses in CHEAPEST-first
     * order — a shut door, then the gate, then the signature — so on an instance that is not
     * answering, a forged ask is turned away as "not-answering" long before any key is checked. The
     * test asserted "unsigned" and passed for that reason until the order was corrected.
     */
    await using tmp = await tmpdir({
      git: true,
      config: { formatter: false, community: { consented: true, answers: { enabled: true } } },
    })
    const victim = asker().networkID
    const forged = asker().ask("what happened today?")

    /**
     * 🔴 The attack this closes: POST a question naming somebody ELSE as the asker.
     *
     * ⚠️ Two things broke at once while `asker` was an unchecked string. The per-asker share of
     * the budget bounded only honest peers, since varying one field bought a fresh share. And the
     * dealing recorded on answering names that key — so anyone could make this instance write
     * "answered nid_victim" about a third party it had never met, which is precisely the
     * bad-mouthing the observation store's engagement bound exists to stop.
     */
    const response = await ask(app(), tmp.path, { ...forged, asker: victim })
    const body = (await response.json()) as { refused?: string }
    expect(body.refused).toBe("unsigned")
  })

  test("⚠️ a malformed question is refused by the SCHEMA, before any of it runs", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, community: { consented: true } } })
    // No asker: the budget cannot be shared out without knowing who is spending it, so this is not a
    // field the handler may default.
    const response = await ask(app(), tmp.path, { question: "and who am I?", at: Date.now(), signature: "x" })
    expect(response.status).toBe(400)
  })
})
