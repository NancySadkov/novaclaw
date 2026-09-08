import { afterEach, describe, expect, test } from "bun:test"
import { generateKeyPairSync, sign as nodeSign } from "node:crypto"
import { readFileSync } from "node:fs"
import { CommunityAnswer } from "@novaclaw/core/community/answer"
import { CommunityConsent } from "@novaclaw/core/community/consent"
import { CommunitySync } from "@novaclaw/core/community/sync"
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
    /**
     * ⚠️ `to` is signed now, so a question names the instance it is for. A test that omitted it
     * would be signing an ask for nobody and asserting on the refusal that produces.
     */
    ask: (question: string, at = Date.now(), to = networkID) => {
      const body = { to, asker: networkID, question, at }
      return {
        ...body,
        signature: nodeSign(null, Buffer.from(CommunityAnswer.askBytes(body)), privateKey).toString("base64url"),
      }
    },
  }
}

/**
 * This instance's own `nid_`, read through its peer identity door.
 *
 * ⚠️ Needed because a question now names WHO IT IS FOR inside the signature, so a fixture that signs
 * for the wrong recipient is testing the refusal rather than the rule. That is not a nuisance — it is
 * the property: a captured ask is worthless at any instance but the one it names.
 */
const selfID = async (handler: ReturnType<typeof app>, directory: string): Promise<string> => {
  const response = await handler(
    new Request("http://localhost/api/community/identity", { headers: { "x-novaclaw-directory": directory } }),
    HttpApiApp.context,
  )
  return ((await response.json()) as { networkID: string }).networkID
}

describe("what a stranger can make this instance spend", () => {
  const handlerSource = readFileSync(
    new URL("../../src/server/routes/instance/httpapi/handlers/community.ts", import.meta.url),
    "utf8",
  )

  test("🔴 the budget counts a TURN THAT RAN, not an answer that arrived", () => {
    /**
     * 🔴 The spend used to be recorded only once an answer existed, so that "a failed turn does not
     * consume the day". Half of that was right and half was a hole: an EMPTY completion is a turn
     * that ran and cost real tokens — and a reasoning model on a tight thinking budget returns
     * exactly that, as this program measured (18 of 24 at 300 tokens).
     *
     * So a stranger who could induce an empty completion spent the user's tokens without ever moving
     * a counter. The spec's own rule: *a bound's enforcement is on the ATTACKER's path* — compare
     * its cost to what the attack costs THEM. Theirs was one signed request.
     *
     * ⚠️ Checked structurally, because the alternative needs a model that can be made to answer
     * nothing on demand. What matters is the ORDER, and the order is visible.
     */
    const answering = handlerSource.slice(handlerSource.indexOf('"communityAsk"'))
    const spend = answering.indexOf("answers.spent")
    const stream = answering.indexOf("ReasoningBudget.stream")
    /**
     * ⚠️ The REFUSAL HELPER, not a literal. Refusals are signed now, so the handler says
     * `refuse("no-answer")` rather than `refused: "no-answer"` — and when that landed, this scan
     * returned -1 and the ordering assertions compared against a position that does not exist. A
     * source ledger has to be taught the shape it polices, or it silently stops policing.
     */
    const emptyCheck = answering.indexOf('refuse("no-answer")')
    expect(emptyCheck, "the scan must find the empty-answer refusal").toBeGreaterThan(-1)

    expect(spend, "the handler must record a spend at all").toBeGreaterThan(-1)
    expect(spend, "and it must be recorded BEFORE the model runs").toBeLessThan(stream)
    expect(spend, "not after the check that discards an empty answer").toBeLessThan(emptyCheck)
    expect(
      answering.slice(emptyCheck).indexOf("answers.spent"),
      "and there must be no second spend after it, which would double-count",
    ).toBe(-1)
  })

  test("🔴 the answering TURN is bounded in time, inside the permit", () => {
    /**
     * 🔴 `ReasoningBudget` bounds tokens; nothing bounded TIME. The 30-second cap on resolving the
     * model carries the reason in its own comment — *"a stuck resolve would hold a stranger's
     * connection open indefinitely"* — and it was never applied to the stream.
     *
     * 🔴 The cost that matters is not the one caller: a slow turn holds the ONE permit, so every
     * other peer is told `busy` until it ends. A single hung provider takes this instance out of the
     * network for everybody.
     */
    const answering = handlerSource.slice(handlerSource.indexOf('"communityAsk"'))
    const permit = answering.indexOf("withPermitsIfAvailable")
    const bound = answering.indexOf("ANSWERING_TURN_MS")
    const closed = answering.indexOf("Option.isNone(answer)")

    expect(bound, "the turn must have a wall-clock bound").toBeGreaterThan(-1)
    /**
     * ⚠️ INSIDE the permit, so the release happens with it. Timing out AROUND the semaphore would
     * answer the caller and leave the work running behind the lock — the same door still shut, with
     * nobody able to see why.
     */
    expect(bound, "and it must sit inside the permit").toBeGreaterThan(permit)
    expect(bound, "before the permit's result is inspected").toBeLessThan(closed)
  })

  test("🔴 an asker waits LONGER than the answerer works", () => {
    /**
     * The two bounds are a pair, and the order between them is the whole point: the peer must stop
     * before we stop waiting. The other way round spends their tokens on an answer nobody will read.
     *
     * ⚠️ And the asker's own budget had to grow. Ten seconds is right for a summary or a page of
     * ids — database reads — and far too short for a model turn, so `askPeer` gave up before any
     * honest instance could reply. The vision's own scenario could not complete against a real model;
     * it only ever succeeded against a stub that answers instantly.
     */
    expect(CommunitySync.ANSWER_TIMEOUT_MS).toBeGreaterThan(10_000)
    const turnBound = Number(/const ANSWERING_TURN_MS = ([0-9_]+)/.exec(handlerSource)?.[1]?.replace(/_/g, "") ?? "0")
    expect(turnBound, "the answering turn must be bounded").toBeGreaterThan(0)
    expect(turnBound, "and must end before the asker gives up").toBeLessThan(CommunitySync.ANSWER_TIMEOUT_MS)
  })

  test("⚠️ a turn that never RAN still costs nothing", () => {
    /**
     * The half of the original reasoning that was right, and it must survive the fix: `busy` (nobody
     * got the permit) and `unavailable` (no model resolved) both return before the stream, so they
     * are still free. A budget that charged for those would let one stranger's question, refused for
     * our own reasons, consume another's share.
     */
    const answering = handlerSource.slice(handlerSource.indexOf('"communityAsk"'))
    const spend = answering.indexOf("answers.spent")
    const busy = answering.indexOf('refuse("busy")')
    expect(busy, "the scan must find the busy refusal").toBeGreaterThan(-1)
    expect(busy, "busy is decided after the spend point").toBeGreaterThan(spend)
    // ⚠️ `unavailable` is returned when `resolveDefault` yielded nothing — which happens BEFORE the
    // stream, and therefore before the spend, inside the answering effect.
    expect(answering).toContain('refuse("unavailable")')
  })
})

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
     * 🔴 Blocked WITHOUT being added first — which is the whole point, and did not work until
     * 2026-08-17. `setBlocked` updated a contact row and did nothing when there was none, so a
     * stranger who found this instance through the public directory could not be blocked at all.
     * The user had to add the person they wanted nothing to do with.
     */
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

    const response = await ask(
      handler,
      tmp.path,
      stranger.ask("what happened today?", Date.now(), await selfID(handler, tmp.path)),
    )
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

test("🔴 answering a stranger does not boot a location graph over the user's HOME", () => {
  /**
   * Review §2 (unit 6 F6). The narrow answering turn resolved its model by taking a location on
   * `process.cwd()` — which on a desktop launch is the user's home — and resolving a location boots
   * the full location graph, including a RECURSIVE file watcher. So a stranger's question started a
   * recursive watch over everything the user owns, and no budget in this subsystem could see it.
   *
   * ⚠️ A source pin rather than a behavioural one, and it says so: proving "no watcher was started
   * over the home directory" needs the real graph and a real home, which no test here has. What it
   * can prove is that the answering turn names an app-managed directory. The `Scratch` module's own
   * documentation carries the property — "NOT the user's home dir (safe by construction)".
   */
  const source = readFileSync(
    new URL("../../src/server/routes/instance/httpapi/handlers/community.ts", import.meta.url),
    "utf8",
  )
  /**
   * ⚠️ COMMENTS STRIPPED FIRST. The fix's own comment explains what it replaced and therefore
   * contains the string this asserts against — a scan over raw source would fail on the prose that
   * documents the fix, which is the "a regex over source counts prose" trap one directory over.
   */
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
  const turn = code.slice(code.indexOf('"communityAsk"'))
  /**
   * ⚠️ The NEXT handler, verified to exist. The first version named a handler that sits earlier in
   * the file, so `indexOf` returned -1 and the slice silently ran to the end — a scan far broader
   * than the one the test claimed to be making.
   */
  const end = turn.indexOf('"communitySuccessionTell"')
  expect(end, "the boundary handler must follow the answering turn").toBeGreaterThan(0)
  const upToEnd = turn.slice(0, end)
  expect(upToEnd, "the answering turn must not take a location on the process working directory").not.toContain(
    "process.cwd()",
  )
  expect(upToEnd, "it answers from the app-managed scratch root").toContain("Scratch.root()")
})
