import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import type { ServerConnection } from "@/context/server"
import {
  InstanceFetchError,
  decodeFault,
  instanceFetch,
  instanceFetchList,
  instanceHeaders,
  instanceUrl,
} from "@/utils/instance-fetch"
import { MessengerApiError, messengerDrivers, messengerUpdateAccount } from "@/utils/messenger-api"
import { createSchedule, listSchedules, removeSchedule, updateSchedule } from "@/utils/calendar-api"
import { adhocDiscard, fsWrite, switchFeature } from "@/utils/fs-api"
import { discoverInstances } from "@/utils/instance-discovery"
import { memoryList } from "@/utils/memory-api"
import { importRecipeArchive, MAX_RECIPE_ARCHIVE_BYTES, recipeArchive, runRecipe } from "@/utils/recipe-api"
import { registryRows } from "@/utils/registry-api"
import { schedulerSnapshot } from "@/utils/scheduler-api"
import { fetchPendingPrompts } from "@/utils/session-pending-api"

/**
 * Two things live here, and they are different in kind.
 *
 * **1. The seam behaves.** `utils/instance-fetch.ts` replaced nine hand-rolled copies of the same
 * HTTP recipe. Five of them decoded a non-2xx differently, so a collapse could silently *lose*
 * information — a server's own message flattened into a status code, a messenger `kind` dropped, a
 * transport outage rewritten as an HTTP error. Ruling 2 (*a fault is never described falsely*) is
 * exactly what a careless collapse breaks, so the fault path is pinned harder than the happy path.
 *
 * **2. The seam stays the only one.** Per ruling 1, an invariant with no mechanical check does not
 * exist — and "all instance HTTP goes through one module" is the kind of invariant that decays by
 * one plausible-looking file at a time. The ledgers below are RATCHETS in the shape of
 * `sdk/js/test/legacy-path-ledger.test.ts` and `core/test/adhoc-store-root.test.ts`: offenders are
 * pinned BY NAME, an unpinned offender fails outright, and a pin the tree no longer justifies fails
 * with "delete the line" so un-pinning is mandatory rather than optional.
 *
 * ⚠️ **Why this specific invariant, and why now.** The collapse is scheduled
 * *before* P2P token rotation, because rotating the instance token with nine copies of the
 * `Authorization` block means nine edits, and a missed one does not fail loudly — it 401s one app
 * screen. The third ledger below is therefore the real deliverable: the written-down list of every
 * file that derives an instance credential.
 *
 * ⚠️ **One divergence is preserved rather than fixed, and it is named here so it is not lost.** All
 * ten raw clients call the GLOBAL `fetch`, while `utils/server-health.ts` routes through
 * `platform.fetch` (the Electron/WSL fetch). If the platform fetch ever matters for these routes —
 * a self-signed cert, a WSL hop — the ten are wrong and the seam is now the one place to fix it.
 * `InstanceRequest.fetch` is the hook. Changing it was out of scope for a mechanical collapse.
 */

const server: ServerConnection.HttpBase = { url: "http://instance.test:4096", password: "hunter2" }
const anonymous: ServerConnection.HttpBase = { url: "http://instance.test:4096/" }

/** A `fetch` stand-in that answers once with exactly what a test asks for. */
function answering(response: Response | (() => never)): typeof globalThis.fetch {
  return ((...args: unknown[]) => {
    void args
    if (typeof response === "function") response()
    return Promise.resolve(response as Response)
  }) as unknown as typeof globalThis.fetch
}

/** Captures the request a client actually built, then answers 204. */
function recording() {
  const seen: { url?: string; init?: RequestInit } = {}
  const fetch = ((url: URL, init: RequestInit) => {
    seen.url = String(url)
    seen.init = init
    return Promise.resolve(new Response(null, { status: 204 }))
  }) as unknown as typeof globalThis.fetch
  return { seen, fetch }
}

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

describe("the base URL and the auth header — the two blocks that were identical in all nine", () => {
  test("a route is joined relative to the instance root, with or without a trailing slash", () => {
    expect(instanceUrl(server, "api/recipe").toString()).toBe("http://instance.test:4096/api/recipe")
    expect(instanceUrl(anonymous, "api/recipe").toString()).toBe("http://instance.test:4096/api/recipe")
    // The nine spelled this `server.url.endsWith("/") ? server.url : server.url + "/"` nine times;
    // dropping it would silently resolve "api/recipe" against the PARENT path of a based URL.
    expect(instanceUrl({ url: "http://host/nova" }, "api/recipe").toString()).toBe("http://host/nova/api/recipe")
  })

  test('an undefined query value is omitted, not sent as the string "undefined"', () => {
    const url = instanceUrl(server, "memory/list", { scopes: "user", limit: undefined, offset: "0" })
    expect(url.searchParams.get("scopes")).toBe("user")
    expect(url.searchParams.has("limit")).toBe(false)
    expect(url.searchParams.get("offset")).toBe("0")
  })

  test("the Authorization header is derived once, and only when there is a password", () => {
    expect(instanceHeaders(server).Authorization).toBe(`Basic ${btoa("novaclaw:hunter2")}`)
    expect(instanceHeaders({ ...server, username: "nancy" }).Authorization).toBe(`Basic ${btoa("nancy:hunter2")}`)
    // No password = no header at all. Sending `Basic <btoa(":")>` instead would turn an open
    // instance into a 401 against a server that was happy to answer.
    expect(instanceHeaders(anonymous).Authorization).toBeUndefined()
    expect(instanceHeaders(anonymous)["content-type"]).toBe("application/json")
  })

  test("extra headers merge without displacing auth", () => {
    const headers = instanceHeaders(server, { "x-novaclaw-directory": "/tmp/p" })
    expect(headers["x-novaclaw-directory"]).toBe("/tmp/p")
    expect(headers.Authorization).toBe(`Basic ${btoa("novaclaw:hunter2")}`)
  })
})

describe("fault decoding — the part where five different answers became one", () => {
  test("the server's own message wins over a status line (recipe-api's old behaviour, now everyone's)", () => {
    const fault = decodeFault({
      method: "POST",
      route: "api/recipe",
      status: 400,
      text: JSON.stringify({ message: "A recipe named 'pi' already exists" }),
    })
    expect(fault.message).toBe("A recipe named 'pi' already exists")
    expect(fault.status).toBe(400)
  })

  test("the NamedError shape (`data.message`) is read too — the same field the SDK's wrapClientError reads", () => {
    const fault = decodeFault({
      method: "GET",
      route: "memory/stats",
      status: 500,
      text: JSON.stringify({ name: "MemoryError", data: { message: "graph is closed" } }),
    })
    expect(fault.message).toBe("graph is closed")
  })

  test("`kind` survives — it is what three messenger call sites branch on", () => {
    const fault = decodeFault({
      method: "POST",
      route: "api/messenger/binding",
      status: 400,
      text: JSON.stringify({ message: "already bound", kind: "messenger_chat_bound" }),
    })
    expect(fault.kind).toBe("messenger_chat_bound")
  })

  test("a non-JSON body still reaches the reader — a proxy's HTML 502 is not silently eaten", () => {
    const fault = decodeFault({ method: "GET", route: "api/recipe", status: 502, text: "<html>Bad Gateway</html>" })
    expect(fault.message).toBe("GET api/recipe failed: 502 <html>Bad Gateway</html>")
    expect(fault.text).toBe("<html>Bad Gateway</html>")
    expect(fault.kind).toBeUndefined()
  })

  test("an empty body falls back to method + route + status, never to a bare number", () => {
    expect(decodeFault({ method: "DELETE", route: "api/recipe/pi", status: 404, text: "" }).message).toBe(
      "DELETE api/recipe/pi failed: 404",
    )
  })

  test("only the RAW-text fallback is length-capped; a server-authored message is never truncated", () => {
    const long = "x".repeat(900)
    expect(decodeFault({ method: "GET", route: "r", status: 500, text: long }).message).toBe(
      `GET r failed: 500 ${"x".repeat(500)}…`,
    )
    const authored = decodeFault({ method: "GET", route: "r", status: 500, text: JSON.stringify({ message: long }) })
    expect(authored.message).toBe(long)
    // …and the verbatim body is kept regardless, for anything that wants the whole thing.
    expect(decodeFault({ method: "GET", route: "r", status: 500, text: long }).text).toBe(long)
  })

  test("a blank message field does not win — it would describe the fault as nothing at all", () => {
    const fault = decodeFault({ method: "GET", route: "r", status: 500, text: JSON.stringify({ message: "   " }) })
    expect(fault.message).toBe(`GET r failed: 500 ${JSON.stringify({ message: "   " })}`)
  })
})

describe("instanceFetch", () => {
  test("a 204 is an answer, not an empty-body fault — every void route in the spec declares it", async () => {
    await expect(
      instanceFetch(server, {
        method: "DELETE",
        route: "api/recipe/pi",
        fetch: answering(new Response(null, { status: 204 })),
      }),
    ).resolves.toBeUndefined()
  })

  test("a 2xx JSON body is parsed", async () => {
    await expect(
      instanceFetch(server, {
        route: "memory/stats",
        directory: "/p",
        fetch: answering(json({ total: 3, valid: 2 }, 200)),
      }),
    ).resolves.toEqual({ total: 3, valid: 2 })
  })

  test("a non-2xx throws an InstanceFetchError carrying status and kind structurally", async () => {
    const promise = instanceFetch(server, {
      method: "POST",
      route: "api/messenger/login/a1/complete",
      fetch: answering(json({ message: "wrong code", kind: "messenger_login_retry" }, 400)),
    })
    const error = await promise.then(() => undefined).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(InstanceFetchError)
    const fault = error as InstanceFetchError
    expect(fault.message).toBe("wrong code")
    expect(fault.status).toBe(400)
    expect(fault.kind).toBe("messenger_login_retry")
    expect(fault.route).toBe("api/messenger/login/a1/complete")
  })

  test("a TRANSPORT failure reaches the caller UNCHANGED — the identity, not merely the shape", async () => {
    // ⚠️ This is the assertion that protects `utils/server-health.ts`'s `retryable()` and every
    // `name === "AbortError"` check in the app. Wrapping a TypeError in an InstanceFetchError would
    // read as tidier and would quietly reclassify "there is no server" as "the server said no".
    const planted = new TypeError("Failed to fetch")
    const thrown = await instanceFetch(server, {
      route: "global/discovery",
      fetch: answering(() => {
        throw planted
      }),
    })
      .then(() => undefined)
      .catch((cause: unknown) => cause)
    expect(thrown).toBe(planted)
    expect(thrown).not.toBeInstanceOf(InstanceFetchError)
  })

  test("a request timeout aborts the transport without wrapping its TimeoutError", async () => {
    let signal: AbortSignal | undefined
    const fetch = ((_url: URL, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        signal = init.signal as AbortSignal
        signal.addEventListener("abort", () => reject(signal?.reason), { once: true })
      })) as unknown as typeof globalThis.fetch
    const thrown = await instanceFetch(server, { route: "provider/presets", timeoutMs: 5, fetch })
      .then(() => undefined)
      .catch((cause: unknown) => cause)
    expect(signal?.aborted).toBe(true)
    expect(thrown).toBeInstanceOf(DOMException)
    expect((thrown as Error).name).toBe("TimeoutError")
  })

  test("a completed request clears its timeout instead of aborting later", async () => {
    const probe = recording()
    await instanceFetch(server, { route: "provider/presets", timeoutMs: 5, fetch: probe.fetch })
    const signal = probe.seen.init?.signal as AbortSignal
    await new Promise((resolve) => setTimeout(resolve, 15))
    expect(signal.aborted).toBe(false)
  })

  test("a 200 that promised a body and sent none is a named fault, not a SyntaxError", async () => {
    const thrown = await instanceFetch(server, {
      route: "api/recipe",
      fetch: answering(new Response("", { status: 200 })),
    })
      .then(() => undefined)
      .catch((cause: unknown) => cause)
    expect(thrown).toBeInstanceOf(InstanceFetchError)
    expect((thrown as Error).message).toBe("GET api/recipe answered 200 with an empty body")
  })

  test("a 200 whose body is not JSON names the route and keeps the body", async () => {
    const thrown = await instanceFetch(server, {
      route: "api/recipe",
      fetch: answering(new Response("<html>login</html>", { status: 200 })),
    })
      .then(() => undefined)
      .catch((cause: unknown) => cause)
    expect(thrown).toBeInstanceOf(InstanceFetchError)
    expect((thrown as Error).message).toBe("GET api/recipe answered non-JSON: 200 <html>login</html>")
  })

  test("`directory` travels as a query param by default and as a header when asked", async () => {
    const query = recording()
    await instanceFetch(server, { route: "memory/stats", directory: "/tmp/p", fetch: query.fetch })
    expect(query.seen.url).toBe("http://instance.test:4096/memory/stats?directory=%2Ftmp%2Fp")
    expect((query.seen.init?.headers as Record<string, string>)["x-novaclaw-directory"]).toBeUndefined()

    const header = recording()
    await instanceFetch(server, {
      method: "POST",
      route: "api/session/ses_1/mode",
      directory: "/tmp/p",
      directoryVia: "header",
      body: { permissionMode: "ask" },
      fetch: header.fetch,
    })
    expect(header.seen.url).toBe("http://instance.test:4096/api/session/ses_1/mode")
    // Percent-encoded: header values are ISO-8859-1, so a non-ASCII path cannot travel raw at all.
    // The SDK has always encoded; this client now matches it. See the round-trip test below.
    expect((header.seen.init?.headers as Record<string, string>)["x-novaclaw-directory"]).toBe("%2Ftmp%2Fp")
    expect(header.seen.init?.body).toBe(JSON.stringify({ permissionMode: "ask" }))
  })

  test("🔴 a non-ASCII directory survives the header, which raw text cannot do", async () => {
    // Ruling 1 for the 2026-08-07 encoding contract. HTTP header values are ISO-8859-1, so a path
    // containing Cyrillic/CJK/accented characters is not merely awkward raw — it is UNREPRESENTABLE.
    // This is the case that decides the contract, and it is why "send the raw path" (which an earlier
    // note of mine recommended, before checking the constraint) is not an option.
    //
    // ⚠️ Asserted as a ROUND TRIP rather than against a literal escaping: the point is that the server
    // can recover the exact path, not that a particular byte sequence was produced.
    const directory = "/tmp/Документы/proj"
    const seen = recording()
    await instanceFetch(server, {
      method: "POST",
      route: "api/session/ses_1/mode",
      directory,
      directoryVia: "header",
      body: { permissionMode: "ask" },
      fetch: seen.fetch,
    })
    const sent = (seen.seen.init?.headers as Record<string, string>)["x-novaclaw-directory"]!
    // Header-safe: every byte is Latin-1 representable, which the raw string is not.
    expect(sent).toMatch(/^[\x20-\x7e]*$/)
    // …and the server recovers exactly what the app meant.
    expect(decodeURIComponent(sent)).toBe(directory)
  })

  test("an absent body sends no body at all", async () => {
    const probe = recording()
    await instanceFetch(server, { method: "GET", route: "api/recipe", fetch: probe.fetch })
    expect(probe.seen.init?.body).toBeUndefined()
  })

  test("a caller-supplied fault factory names the error without owning the decoding", async () => {
    const thrown = await instanceFetch(server, {
      route: "api/messenger/driver",
      fault: (fault) => new MessengerApiError(fault),
      fetch: answering(json({ message: "nope", kind: "messenger_login_retry" }, 400)),
    })
      .then(() => undefined)
      .catch((cause: unknown) => cause)
    expect(thrown).toBeInstanceOf(MessengerApiError)
    expect(thrown).toBeInstanceOf(InstanceFetchError)
    expect((thrown as MessengerApiError).retryableLogin).toBe(true)
    expect((thrown as MessengerApiError).name).toBe("MessengerApiError")
  })

  test("MessengerApiError still distinguishes a retryable login from anything else", () => {
    const base = { method: "POST", route: "r", status: 400, text: "" }
    expect(new MessengerApiError({ ...base, kind: "messenger_login_retry", message: "m" }).retryableLogin).toBe(true)
    expect(new MessengerApiError({ ...base, kind: "messenger_chat_bound", message: "m" }).retryableLogin).toBe(false)
    expect(new MessengerApiError({ ...base, kind: undefined, message: "m" }).retryableLogin).toBe(false)
  })
})

describe("instanceFetchList — a peer on another version must not cost the user their session", () => {
  test("a list passes through", async () => {
    await expect(
      instanceFetchList(
        server,
        { route: "api/messenger/driver", fetch: answering(json([{ id: "telegram" }], 200)) },
        "drivers",
      ),
    ).resolves.toEqual([{ id: "telegram" }])
  })

  test("a non-list coerces to empty AND names itself on the console — it never renders empty in silence", async () => {
    const warnings: string[] = []
    const original = console.warn
    console.warn = (...args: unknown[]) => void warnings.push(args.join(" "))
    try {
      // `{}` is exactly what a peer on an older protocol sends, and what the e2e mock's catch-all
      // returns. Truthy, so the pre-2026-07-28 code published it and the next `.filter` threw
      // inside a render — the whole UI replaced by "Something went wrong".
      const rows = await instanceFetchList(
        server,
        { route: "api/messenger/binding", fetch: answering(json({}, 200)) },
        "bindings",
      )
      expect(rows).toEqual([])
    } finally {
      console.warn = original
    }
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("api/messenger/binding")
    expect(warnings[0]).toContain("not a list of bindings")
  })
})

/**
 * **The wire, per client.** "The seam behaves" and "this app still sends what it used to" are two
 * different claims, and the second is the one the owner cannot check for themselves. These nine
 * modules are the clients behind Calendar, Files, Memory, Messenger, Recipes, Registry, Scheduler,
 * Trash and the pending-prompt strip, so a wrong URL or a dropped header is a dead app screen and
 * nothing else in this suite would notice.
 *
 * So these drive the REAL exported functions against a stubbed global `fetch`, and every expectation
 * below was read off the PRE-collapse source rather than off the new code. Importing all nine at the
 * top of this file also means a syntax or module-evaluation error in any of them fails here.
 */
describe("every collapsed client still puts the same request on the wire", () => {
  const auth = `Basic ${btoa("novaclaw:hunter2")}`

  /** Stubs the GLOBAL fetch — which is what all nine actually call — and always restores it. */
  async function wire(run: () => Promise<unknown>, answer?: { status?: number; body?: unknown }) {
    const seen: { url?: string; init?: RequestInit } = {}
    const original = globalThis.fetch
    globalThis.fetch = ((url: URL | RequestInfo, init?: RequestInit) => {
      seen.url = String(url)
      seen.init = init
      const status = answer?.status ?? 204
      return Promise.resolve(
        answer?.body === undefined
          ? new Response(null, { status })
          : new Response(JSON.stringify(answer.body), { status }),
      )
    }) as unknown as typeof globalThis.fetch
    try {
      await run()
    } finally {
      globalThis.fetch = original
    }
    const headers = (seen.init?.headers ?? {}) as Record<string, string>
    return { url: seen.url, method: seen.init?.method ?? "GET", headers, body: seen.init?.body }
  }

  test("calendar-api -> instance-global reads carry no directory", async () => {
    const sent = await wire(() => listSchedules(server), { status: 200, body: [] })
    expect(sent.url).toBe("http://instance.test:4096/api/calendar/schedule")
    expect(sent.method).toBe("GET")
    expect(sent.headers.Authorization).toBe(auth)
    expect(sent.headers["content-type"]).toBe("application/json")
  })

  test("calendar-api -> create/update route the ambient directory in a header, outside the schedule body", async () => {
    const recurrence = { kind: "daily" as const, time: { hour: 9, minute: 0 } }
    const created = await wire(() => createSchedule(server, "C:/work/Календарь", { recurrence, prompt: "review" }), {
      status: 200,
      body: {},
    })
    expect(created.url).toBe("http://instance.test:4096/api/calendar/schedule")
    expect(created.method).toBe("POST")
    expect(created.headers["x-novaclaw-directory"]).toBe(encodeURIComponent("C:/work/Календарь"))
    expect(created.body).toBe(JSON.stringify({ recurrence, prompt: "review" }))

    const updated = await wire(() => updateSchedule(server, "/work/current", "sch 1", { agent: "nova" }), {
      status: 200,
      body: {},
    })
    expect(updated.url).toBe("http://instance.test:4096/api/calendar/schedule/sch%201")
    expect(updated.method).toBe("PATCH")
    expect(updated.headers["x-novaclaw-directory"]).toBe(encodeURIComponent("/work/current"))
    expect(updated.body).toBe(JSON.stringify({ agent: "nova" }))
  })

  test("calendar-api -> DELETE tolerates the declared 204 rather than throwing on an empty body", async () => {
    const sent = await wire(() => removeSchedule(server, "sch 1"))
    expect(sent.url).toBe("http://instance.test:4096/api/calendar/schedule/sch%201")
    expect(sent.method).toBe("DELETE")
  })

  test("recipe-api -> POST /api/recipe/{slug}/run, slug encoded, body carried", async () => {
    const sent = await wire(() => runRecipe(server, "a b", { directory: "/w" }), { status: 200, body: {} })
    expect(sent.url).toBe("http://instance.test:4096/api/recipe/a%20b/run")
    expect(sent.method).toBe("POST")
    expect(sent.body).toBe(JSON.stringify({ directory: "/w" }))
  })

  test("recipe-api -> ZIP upload/download keep remote routing, auth, and raw bytes", async () => {
    const original = globalThis.fetch
    const seen: Array<{ url: string; init?: RequestInit }> = []
    const downloaded = Uint8Array.of(0x50, 0x4b, 3, 4, 0, 255)
    globalThis.fetch = ((url: URL | RequestInfo, init?: RequestInit) => {
      seen.push({ url: String(url), init })
      return Promise.resolve(
        seen.length === 1
          ? new Response(downloaded, { status: 200, headers: { "content-type": "application/zip" } })
          : json({ slug: "arrived" }, 200),
      )
    }) as unknown as typeof globalThis.fetch
    try {
      const abort = new AbortController()
      expect(await recipeArchive(server, "folder one", { signal: abort.signal, timeoutMs: 1_000 })).toEqual(downloaded)
      expect(
        (await importRecipeArchive(server, downloaded, { slug: "copy one", signal: abort.signal, timeoutMs: 1_000 }))
          .slug,
      ).toBe("arrived")
    } finally {
      globalThis.fetch = original
    }

    expect(seen[0]?.url).toBe("http://instance.test:4096/api/recipe/folder%20one/archive")
    const downloadHeaders = new Headers(seen[0]?.init?.headers)
    expect(downloadHeaders.get("authorization")).toBe(auth)
    expect(downloadHeaders.get("accept")).toBe("application/zip")
    expect(seen[0]?.init?.signal).toBeInstanceOf(AbortSignal)
    expect(seen[1]?.url).toBe("http://instance.test:4096/api/recipe/archive?slug=copy+one")
    const uploadHeaders = new Headers(seen[1]?.init?.headers)
    expect(uploadHeaders.get("authorization")).toBe(auth)
    expect(uploadHeaders.get("content-type")).toBe("application/zip")
    expect(seen[1]?.init?.body).toBe(downloaded)
    expect(seen[1]?.init?.signal).toBeInstanceOf(AbortSignal)
  })

  test("recipe-api -> a lengthless oversized download is cancelled before one huge allocation", async () => {
    const original = globalThis.fetch
    let cancelled = false
    const chunk = new Uint8Array(MAX_RECIPE_ARCHIVE_BYTES / 2 + 1)
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(chunk)
              controller.enqueue(chunk)
            },
            cancel() {
              cancelled = true
            },
          }),
          { status: 200, headers: { "content-type": "application/zip" } },
        ),
      )) as unknown as typeof globalThis.fetch
    try {
      await expect(recipeArchive(server, "too-large")).rejects.toThrow(/over 32 MB/)
    } finally {
      globalThis.fetch = original
    }
    expect(cancelled).toBe(true)
  })

  test("fs-api -> the write endpoints route `directory` as a QUERY param", async () => {
    const sent = await wire(() => fsWrite(server, { directory: "/w", path: "a.txt", content: "hi" }), {
      status: 200,
      body: { ok: true },
    })
    expect(sent.url).toBe("http://instance.test:4096/file/content?directory=%2Fw")
    expect(sent.method).toBe("PUT")
    expect(sent.body).toBe(JSON.stringify({ path: "a.txt", content: "hi" }))
    expect(sent.headers["x-novaclaw-directory"]).toBeUndefined()
  })

  test("fs-api -> the session controls route `directory` as a HEADER and expect 204", async () => {
    const sent = await wire(() =>
      switchFeature(server, { directory: "/w", sessionID: "ses_1", feature: "safeMode", enabled: null }),
    )
    expect(sent.url).toBe("http://instance.test:4096/api/session/ses_1/feature")
    expect(sent.method).toBe("POST")
    expect(sent.headers["x-novaclaw-directory"]).toBe("%2Fw")
    expect(sent.body).toBe(JSON.stringify({ feature: "safeMode", enabled: null }))
  })

  test("fs-api -> the ad-hoc surface encodes both path segments", async () => {
    const sent = await wire(() => adhocDiscard(server, { directory: "/w", sessionID: "ses 1", name: "a b" }), {
      status: 200,
      body: { removed: true },
    })
    expect(sent.url).toBe("http://instance.test:4096/adhoc/session/ses%201/a%20b?directory=%2Fw")
    expect(sent.method).toBe("DELETE")
  })

  test("memory-api -> /memory/list keeps directory and drops only the ABSENT filters", async () => {
    const sent = await wire(() => memoryList(server, { directory: "/w", scopes: ["user", "project"], limit: 50 }), {
      status: 200,
      body: [],
    })
    expect(sent.url).toBe("http://instance.test:4096/memory/list?directory=%2Fw&scopes=user%2Cproject&limit=50")
  })

  test("registry-api -> /registry/rows keeps table and paging", async () => {
    const sent = await wire(() => registryRows(server, { directory: "/w", table: "session", limit: 100 }), {
      status: 200,
      body: {},
    })
    expect(sent.url).toBe("http://instance.test:4096/registry/rows?directory=%2Fw&table=session&limit=100")
  })

  test("scheduler-api -> GET /scheduler/snapshot with directory", async () => {
    const sent = await wire(() => schedulerSnapshot(server, { directory: "/w" }), { status: 200, body: [] })
    expect(sent.url).toBe("http://instance.test:4096/scheduler/snapshot?directory=%2Fw")
    expect(sent.method).toBe("GET")
  })

  test("session-pending-api -> the header channel, and a fault still resolves to an empty list", async () => {
    const sent = await wire(() => fetchPendingPrompts(server, { directory: "/w", sessionID: "ses_1" }), {
      status: 200,
      body: { data: [{ id: "p1", text: "hi", delivery: "ui", timeCreated: 1 }] },
    })
    expect(sent.url).toBe("http://instance.test:4096/api/session/ses_1/pending")
    expect(sent.headers["x-novaclaw-directory"]).toBe("%2Fw")
    // The documented swallow: its caller polls every 2s and already catches.
    await wire(
      async () => expect(await fetchPendingPrompts(server, { directory: "/w", sessionID: "ses_1" })).toEqual([]),
      {
        status: 500,
        body: { message: "boom" },
      },
    )
  })

  test("instance-discovery -> GET /global/discovery, unwrapped, with the sibling headers", async () => {
    const sent = await wire(() => discoverInstances(server), { status: 200, body: { instances: [] } })
    expect(sent.url).toBe("http://instance.test:4096/global/discovery")
    expect(sent.headers.Authorization).toBe(auth)
    // ⚠️ The ONE deliberate wire change in this collapse: it used to omit content-type on its
    // bodyless GET while its eight siblings sent it. Measured safe — the instance's CORS middleware
    // (`httpapi/server.ts`) declares no allowedHeaders restriction, and the eight are live proof.
    expect(sent.headers["content-type"]).toBe("application/json")
  })

  test("messenger-api -> a mutation carries its body and tolerates the declared 204", async () => {
    const sent = await wire(() => messengerUpdateAccount(server, "acc_1", { enabled: false }))
    expect(sent.url).toBe("http://instance.test:4096/api/messenger/account/acc_1")
    expect(sent.method).toBe("PATCH")
    expect(sent.body).toBe(JSON.stringify({ enabled: false }))
  })

  test("messenger-api -> a list route that answers a non-list still shows none rather than crashing", async () => {
    const original = console.warn
    console.warn = () => {}
    try {
      await wire(async () => expect(await messengerDrivers(server)).toEqual([]), { status: 200, body: {} })
    } finally {
      console.warn = original
    }
  })
})

// ---------------------------------------------------------------------------------------------
// The ledgers. Everything below reads the tree from disk.
// ---------------------------------------------------------------------------------------------

/** `packages/app/src/utils` → `packages/app/src`. */
const SRC = path.resolve(import.meta.dir, "..")

/** The seam itself — the ONE module allowed to call `fetch` directly. */
const SEAM = "utils/instance-fetch.ts"

/**
 * A bare `fetch(...)` call, however it is spelled. The lookbehind is what keeps `refetch(` and
 * `prefetch(` — solid-query's own vocabulary, all over this app — out of the offender set.
 */
const BARE_FETCH = /(?<![\w$.])fetch\s*\(/
const QUALIFIED_FETCH = /\b(?:globalThis|window|self)\.fetch\s*\(/

/**
 * ⚠️ **Comments are prose, and a ledger that fires on prose gets deleted rather than obeyed.**
 * Caught on the first run of this file: `utils/error-log.ts` was reported as an offender because a
 * comment there says *"release-notes fetch (context/highlights.tsx)"* — a space before the paren,
 * which the `\s*` above happily matched. Stripping comments first is the fix, and the guard is
 * strictly better for it: `\s*` stays, so an actual `fetch (url)` is still caught.
 *
 * The line-comment pattern uses the negative lookbehind AGENTS.md pitfall #6 exists for — a bare
 * `//` also matches the `//` in `http://`, which would eat the rest of any line containing a URL.
 */
const withoutComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(?<!:)\/\/[^\n]*/g, " ")

/**
 * ⚠️ **A string is data, and a ledger that fires on data gets deleted rather than obeyed** — the same
 * lesson as `withoutComments` above, one input class over. Caught 2026-08-18: `apps/skills.ts` scans a
 * skill's instructions for network-ish words, and one of its scan terms is the literal `"fetch("`, so
 * this detector reported a file that makes no request at all.
 *
 * Only the BODY is blanked, and only for quoted strings — the quotes stay, so a real
 * `fetch("http://host/x")` still matches `BARE_FETCH`. The identifier of a genuine call is always
 * OUTSIDE the quotes, so no true positive can hide inside its own argument. The `\\.` alternative is
 * what stops an escaped quote from ending the literal early and re-exposing the rest as code.
 *
 * 🔴 **Template literals are deliberately NOT blanked.** `${fetch(url)}` is a real call, and blanking
 * template bodies would hide it — trading a false positive for a false negative, which is the wrong
 * direction for a guard to move.
 */
const withoutStringBodies = (source: string) =>
  source.replace(/"(?:[^"\\\n]|\\.)*"/g, '""').replace(/'(?:[^'\\\n]|\\.)*'/g, "''")

const callsFetch = (input: string) => {
  const source = withoutStringBodies(withoutComments(input))
  return BARE_FETCH.test(source) || QUALIFIED_FETCH.test(source)
}

function walk(dir: string, into: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, into)
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) into.push(full)
  }
  return into
}

const relative = (file: string) => path.relative(SRC, file).split(path.sep).join("/")

const SOURCES = walk(SRC).map((file) => ({ path: relative(file), source: fs.readFileSync(file, "utf8") }))

/** Pure so the negative controls below can drive it with fabricated input. */
export function offenders(
  files: readonly { path: string; source: string }[],
  predicate: (source: string) => boolean,
  allowed: ReadonlySet<string>,
): string[] {
  return files
    .filter((file) => predicate(file.source) && !allowed.has(file.path))
    .map((file) => file.path)
    .sort()
}

/** Ledger entries the tree no longer justifies — one line each, with what to do about it. */
export function stalePins(
  files: readonly { path: string; source: string }[],
  predicate: (source: string) => boolean,
  pinned: readonly string[],
): string[] {
  const hits = new Set(files.filter((file) => predicate(file.source)).map((file) => file.path))
  const seen = new Set<string>()
  const stale: string[] = []
  for (const entry of pinned) {
    if (seen.has(entry)) {
      stale.push(`${entry} (pinned twice — delete the duplicate line)`)
      continue
    }
    seen.add(entry)
    if (!hits.has(entry)) stale.push(`${entry} (no longer matches — DELETE the ledger line; the pin only shrinks)`)
  }
  return stale
}

/**
 * **The raw-`fetch` ledger, pinned 2026-07-31 — and EMPTY since 2026-09-01.** Nine files in `utils/`
 * held 11 `fetch(` calls; all eleven are gone. The tenth client, `apps/persisted.ts` (`GET /app`,
 * the persisted app-registry manifests), sat outside `utils/` with its own base-URL join and its own
 * `Authorization` block — the copy a P2P token rotation would miss. It now calls `instanceFetch`,
 * so its line is deleted, as this ledger's own shrink-only rule requires.
 *
 * ⚠️ With the list empty, the "can only SHRINK" test below is vacuous — nothing is pinned, so
 * nothing can go stale. The test that carries the weight is the one above it, which is now at FULL
 * strength: every file in `packages/app/src` except the seam must be free of `fetch(`, with zero
 * exceptions. Do not repopulate this array to make room for a new client; that is the offence it
 * detects.
 *
 * This list may only ever get SHORTER.
 */
const RAW_FETCH_OFFENDERS: readonly string[] = []

/**
 * **The instance-credential ledger, pinned 2026-07-31 — the P2P token-rotation checklist.**
 *
 * ⚠️ This is the ledger the roadmap item actually exists for. When the instance token changes shape,
 * THESE are the files that change, and a file that derives a credential without appearing here is
 * the failure mode the collapse was scheduled to prevent. It may only ever get SHORTER.
 */
const CREDENTIAL_SITES: readonly string[] = [
  // (1) Defines `authTokenFromCredentials` and applies it for the GENERATED SDK client. The other
  //     half of the seam; not residue.
  "utils/server.ts",
  // (2) Applies it for every raw fetch. The seam. Not residue.
  SEAM,
  // (3) LEGITIMATE and expected to stay: a browser WebSocket cannot carry an Authorization header,
  //     so the pty terminal puts the same token in the URL. It cannot use `instanceHeaders`, but it
  //     absolutely must be on the rotation checklist — which is the whole point of writing the list
  //     down instead of grepping for it.
  "utils/terminal-websocket-url.ts",
]

const REMEDY = [
  "Route the call through `utils/instance-fetch.ts` (`instanceFetch` / `instanceFetchList`).",
  "It owns the base URL, the Authorization header, and how a non-2xx becomes an Error — which is",
  "why there is one of it. If a call genuinely cannot go through it, add the file to the ledger in",
  "this test and expect to justify growing a set that is supposed to shrink.",
].join("\n  ")

describe("the sweep can actually see the tree", () => {
  test("it found a real source set, not an empty one", () => {
    // Every assertion below is `toEqual([])`. A mis-resolved SRC would empty the scan and turn all
    // of them into tautologies that pass forever — the exact failure this block makes impossible.
    expect(fs.existsSync(SRC), `${SRC} is gone — repoint the sweep`).toBe(true)
    expect(SOURCES.length).toBeGreaterThan(200)
    expect(
      SOURCES.some((file) => file.path === SEAM),
      "the seam itself is not in the scan",
    ).toBe(true)
    expect(
      SOURCES.some((file) => file.path.endsWith(".test.ts")),
      "test files leaked into the scan",
    ).toBe(false)
  })

  test("the detector distinguishes a fetch call from the words that contain it", () => {
    expect(callsFetch("const res = await fetch(url)")).toBe(true)
    expect(callsFetch("globalThis.fetch(url)")).toBe(true)
    expect(callsFetch("return fetch (url)")).toBe(true)
    // solid-query's vocabulary, which is everywhere in this app and is not an offence.
    expect(callsFetch("void resource.refetch()")).toBe(false)
    expect(callsFetch("router.prefetch(href)")).toBe(false)
    expect(callsFetch("const f: typeof fetch = platform.fetch ?? globalThis.fetch")).toBe(false)
    // Prose is not code. This exact string is in `utils/error-log.ts` and it failed the first run.
    expect(callsFetch("// release-notes fetch (context/highlights.tsx) hands its line here")).toBe(false)
    expect(callsFetch("/* a block comment mentioning fetch(url) */")).toBe(false)
    // …but a comment must not be able to HIDE a real call on the same file.
    expect(callsFetch("// mentions fetch(\nconst res = await fetch(url)")).toBe(true)
    // …and a URL in a string must not swallow the rest of the line (AGENTS.md pitfall #6).
    expect(callsFetch('const res = await fetch("http://host/x")')).toBe(true)
    // A scan term in a DATA array is not a call. `apps/skills.ts` really does contain this one.
    expect(callsFetch('const NETWORK = ["http://", "curl", "fetch(", "upload"]')).toBe(false)
    expect(callsFetch("const terms = ['fetch(']")).toBe(false)
    // …but a string must not HIDE a real call sitting next to it on the same line.
    expect(callsFetch('const a = "fetch("; const res = await fetch(url)')).toBe(true)
    // An escaped quote must not end the literal early and re-expose the rest as code.
    expect(callsFetch('const a = "he said \\"fetch(\\" loudly"')).toBe(false)
    // A template literal still exposes a real call in an interpolation.
    expect(callsFetch("const res = await `${fetch(url)}`")).toBe(true)
  })
})

describe("all instance HTTP goes through one module, and the exception list can only shrink", () => {
  test("no file under utils/ except the seam calls fetch — the nine are gone and stay gone", () => {
    const inUtils = SOURCES.filter((file) => file.path.startsWith("utils/"))
    expect(inUtils.length).toBeGreaterThan(20)
    const found = offenders(inUtils, callsFetch, new Set([SEAM]))
    expect(
      found,
      ["A module in packages/app/src/utils calls fetch() directly:", `  ${found.join("\n  ")}`, "", `  ${REMEDY}`].join(
        "\n",
      ),
    ).toEqual([])
  })

  test("a new raw-fetch client anywhere in the app fails HERE, not in a review", () => {
    const found = offenders(SOURCES, callsFetch, new Set([SEAM, ...RAW_FETCH_OFFENDERS]))
    expect(
      found,
      ["A file calls fetch() directly and is not on the ledger:", `  ${found.join("\n  ")}`, "", `  ${REMEDY}`].join(
        "\n",
      ),
    ).toEqual([])
  })

  test("the raw-fetch ledger can only SHRINK — a converted file must be DELETED from it", () => {
    const stale = stalePins(SOURCES, callsFetch, RAW_FETCH_OFFENDERS)
    expect(
      stale,
      [
        "The raw-fetch ledger pins files the tree no longer justifies. Un-pinning is MANDATORY:",
        `  ${stale.join("\n  ")}`,
        "",
        "  Delete those lines from RAW_FETCH_OFFENDERS. A ledger that keeps dead entries stops being",
        "  a measurement of the real surface.",
      ].join("\n"),
    ).toEqual([])
  })

  test("the raw-fetch ledger is exactly today's measured residue", () => {
    // Pinned as a MEASUREMENT: the honest answer to "how many raw clients are left". It was 10 on
    // 2026-07-31 and 1 after the nine in `utils/` collapsed; folding `apps/persisted.ts` in was
    // supposed to fail here, and it did (2026-09-01). It is 0 now — the residue is gone, and this
    // pin exists so that a NEW exception has to be recorded on purpose rather than appended.
    expect(RAW_FETCH_OFFENDERS.length, "the residue moved — recount and update this pin").toBe(0)
  })
})

describe("the P2P token-rotation surface is a written-down list, not a grep", () => {
  const derivesCredential = (source: string) => source.includes("authTokenFromCredentials")

  test("every file that derives an instance credential is on the ledger", () => {
    const found = offenders(SOURCES, derivesCredential, new Set(CREDENTIAL_SITES))
    expect(
      found,
      [
        "A file derives an instance credential and is not on the rotation ledger:",
        `  ${found.join("\n  ")}`,
        "",
        "  Use `instanceHeaders` from utils/instance-fetch.ts (raw HTTP) or `createSdkForServer`",
        "  from utils/server.ts (the generated client). If it can be neither — a WebSocket URL is",
        "  the one real case — add it to CREDENTIAL_SITES with the reason, because the next token",
        "  rotation has to find it.",
      ].join("\n"),
    ).toEqual([])
  })

  test("the rotation ledger can only SHRINK", () => {
    const stale = stalePins(SOURCES, derivesCredential, CREDENTIAL_SITES)
    expect(stale, `Delete these lines from CREDENTIAL_SITES:\n  ${stale.join("\n  ")}`).toEqual([])
  })

  test("the ledger has no duplicate lines and is the measured size", () => {
    expect(new Set(CREDENTIAL_SITES).size).toBe(CREDENTIAL_SITES.length)
    // 4 until 2026-09-01, when `apps/persisted.ts` stopped deriving its own header.
    expect(CREDENTIAL_SITES.length, "the rotation surface moved — recount and update this pin").toBe(3)
  })
})

describe("the guards actually bite (negative control)", () => {
  test("a fabricated offender is reported, and the seam never is", () => {
    // Every real assertion above is `toEqual([])`, and an empty array alone cannot demonstrate that
    // a non-empty one is reachable. These drive the same pure predicates directly.
    const planted = [
      { path: SEAM, source: "await fetch(url)" },
      { path: "utils/brand-new-api.ts", source: "const res = await fetch(url, { headers })" },
      { path: "utils/innocent.ts", source: "void resource.refetch()" },
    ]
    expect(offenders(planted, callsFetch, new Set([SEAM]))).toEqual(["utils/brand-new-api.ts"])
    // …and the ledger is what excuses a file, nothing else.
    expect(offenders(planted, callsFetch, new Set([SEAM, "utils/brand-new-api.ts"]))).toEqual([])
    expect(offenders(planted, callsFetch, new Set())).toEqual(["utils/brand-new-api.ts", SEAM])
  })

  test("the shrink half reports a pin the tree no longer justifies", () => {
    const tree = [{ path: "apps/persisted.ts", source: "await fetch(url)" }]
    expect(stalePins(tree, callsFetch, ["apps/persisted.ts", "utils/converted-yesterday.ts"])).toEqual([
      "utils/converted-yesterday.ts (no longer matches — DELETE the ledger line; the pin only shrinks)",
    ])
    expect(stalePins(tree, callsFetch, ["apps/persisted.ts", "apps/persisted.ts"])).toEqual([
      "apps/persisted.ts (pinned twice — delete the duplicate line)",
    ])
    expect(stalePins(tree, callsFetch, ["apps/persisted.ts"])).toEqual([])
  })
})
