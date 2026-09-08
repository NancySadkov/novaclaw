import { afterEach, describe, expect, test } from "bun:test"
import { ConfigProvider, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { CommunityConsent } from "@novaclaw/core/community/consent"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

/**
 * 🔴 The user's trust rating, ACROSS THE HTTP SEAM — the place this program's defects actually live.
 *
 * Three separate failures in one field, none visible to types or to a core test:
 *
 *   · the response schema did not declare `trust`, so the API answered contacts without it —
 *     indistinguishable from never having stored it;
 *   · the payload schema declared it and the HANDLER did not forward it, so the POST answered 200
 *     with the old rating intact — a success that changed nothing;
 *   · and both were found by hand, against a live instance, because nothing in the suite crossed
 *     that seam.
 *
 * ⚠️ So this drives the real routes in-process: write, read back, and assert the VALUE rather than
 * the status code. A 200 proved nothing in either incident.
 */

function app() {
  return HttpRouter.toWebHandler(
    HttpApiApp.routes.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({})))),
    { disableLogger: true },
  ).handler
}

/**
 * 🔴 ONE handler for the whole file, not one per request.
 *
 * ⚠️ Built per call at first, and the symptom was subtle: every POST answered correctly and every
 * GET came back EMPTY, because each request got its own graph and nothing written in one was visible
 * to the next. That reads exactly like "the list schema drops the field" — the bug this file was
 * written to catch — so the harness would have accused the product of its own defect.
 */
const handler = app()

const at = (route: string, directory: string, method: "GET" | "POST", body?: unknown) => {
  const payload = body === undefined ? undefined : JSON.stringify(body)
  return handler(
    new Request(`http://localhost${route}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-novaclaw-directory": directory,
        ...(payload === undefined ? {} : { "content-length": String(new TextEncoder().encode(payload).length) }),
      },
      ...(payload === undefined ? {} : { body: payload }),
    }),
    HttpApiApp.context,
  )
}

const send = (directory: string, method: "GET" | "POST", body?: unknown) => {
  const payload = body === undefined ? undefined : JSON.stringify(body)
  return handler(
    new Request("http://localhost/api/community/contact", {
      method,
      headers: {
        "content-type": "application/json",
        "x-novaclaw-directory": directory,
        ...(payload === undefined ? {} : { "content-length": String(new TextEncoder().encode(payload).length) }),
      },
      ...(payload === undefined ? {} : { body: payload }),
    }),
    HttpApiApp.context,
  )
}

/** A valid ed25519-shaped identity: `add` refuses anything that cannot parse as a public key. */
const identity = (fill: number) => `nid_${Buffer.alloc(32, fill).toString("base64url")}`

describe("the other community fields that cross the same seam", () => {
  afterEach(() => CommunityConsent.resetGate())
  afterEach(disposeAllInstances)

  test("🔴 the ANSWERING state reaches the panel, with its budget", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: { formatter: false, community: { consented: true, answers: { enabled: true, perDay: 7 } } },
    })

    /**
     * ⚠️ This is the field whose absence made the capability look broken rather than off. The
     * panel decides what to show from it, so a drop here means a user who turned answering ON is
     * told it is off — and nothing anywhere reports a fault.
     */
    const body = (await (await at("/api/community/participation", tmp.path, "GET")).json()) as {
      answers?: { enabled?: boolean; perDay?: number; today?: number }
    }
    expect(body.answers?.enabled).toBe(true)
    expect(body.answers?.perDay).toBe(7)
    expect(body.answers?.today).toBe(0)
  })

  test("🔴 DISCOVER reports how the seed door went, so an empty result can name its reason", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: { formatter: false, community: { consented: true, seeds: { enabled: false } } },
    })

    /**
     * ⚠️ Without these two, three different situations collapse into "found nobody yet", and only
     * some are fixed by pasting an address. A dropped field here does not break a feature — it
     * makes the app give bad advice, which is harder to notice and worse to receive.
     */
    const body = (await (await at("/api/community/discover", tmp.path, "POST", {})).json()) as {
      seedsAsked?: boolean
      seedsFound?: number
    }
    expect(body.seedsAsked).toBe(false)
    expect(body.seedsFound).toBe(0)
  })
})

describe("a trust rating survives the HTTP seam", () => {
  // The consent gate is process-wide; a test that joins must un-join or it weakens the next one.
  afterEach(() => CommunityConsent.resetGate())
  afterEach(disposeAllInstances)

  test("🔴 written, then read back with its VALUE — not merely a 200", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, community: { consented: true } } })
    const who = identity(0x41)

    const created = (await (await send(tmp.path, "POST", { networkID: who, petname: "my guru", trust: 4 })).json()) as {
      trust?: number
    }
    // The POST's own answer, which is where the unforwarded-payload bug hid: it returned the OLD
    // record, so only comparing against what was sent reveals it.
    expect(created.trust).toBe(4)

    const listed = (await (await send(tmp.path, "GET")).json()) as ReadonlyArray<{
      networkID: string
      trust?: number
    }>
    // And the LIST, which is where the undeclared-response bug hid — a different schema from the POST.
    expect(listed.find((entry) => entry.networkID === who)?.trust).toBe(4)
  })

  test("🔴 a rating can be CHANGED, and a rename does not clear it", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, community: { consented: true } } })
    const who = identity(0x42)

    await send(tmp.path, "POST", { networkID: who, petname: "my guru", trust: 5 })
    const lowered = (await (await send(tmp.path, "POST", { networkID: who, trust: 2 })).json()) as { trust?: number }
    expect(lowered.trust).toBe(2)

    /**
     * ⚠️ Omitting the field must leave it alone. A rename that silently un-rated somebody would
     * destroy the user's own sentence as a side effect of an unrelated edit, and they would have no
     * way to notice.
     */
    const renamed = (await (await send(tmp.path, "POST", { networkID: who, petname: "renamed" })).json()) as {
      petname?: string
      trust?: number
    }
    expect(renamed.petname).toBe("renamed")
    expect(renamed.trust).toBe(2)
  })

  test("⚠️ out of range is CLAMPED, never refused", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, community: { consented: true } } })
    const who = identity(0x43)

    // A bad number is a caller's mistake, not a reason to reject somebody's doorman — but storing 9
    // as given would outrank every honest 5 forever, since only the ORDER is ever read.
    const high = (await (await send(tmp.path, "POST", { networkID: who, trust: 9 })).json()) as { trust?: number }
    expect(high.trust).toBe(5)
    const low = (await (await send(tmp.path, "POST", { networkID: who, trust: -3 })).json()) as { trust?: number }
    expect(low.trust).toBe(1)
  })

  test("⚠️ an unrated contact reports NO rating, not zero", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, community: { consented: true } } })
    const who = identity(0x44)

    // The ordinary state of everyone met through peer exchange. Reading absence as "trusted 0" would
    // rank the whole network below one stranger who was typed in once.
    const plain = (await (await send(tmp.path, "POST", { networkID: who })).json()) as { trust?: number }
    expect(plain.trust).toBeUndefined()
  })
})
