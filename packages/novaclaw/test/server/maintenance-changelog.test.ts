import { expect, test } from "bun:test"
import { Effect } from "effect"
import { Offline } from "@novaclaw/core/offline"
import { CHANGELOG_MAX_BYTES, fetchChangelog } from "../../src/server/maintenance/changelog"

const open: Offline.Policy = { enabled: false, allowedHosts: new Set() }
const airgapped: Offline.Policy = { enabled: true, allowedHosts: new Set() }

function recordingFetcher(body: string, status = 200) {
  const calls: string[] = []
  const fetcher = (async (url: string | URL | Request) => {
    calls.push(String(url))
    return new Response(body, { status })
  }) as unknown as typeof globalThis.fetch
  return { fetcher, calls }
}

/**
 * 🔴 NC-SEC-015 — an airgapped instance used to announce itself once per version change.
 *
 * The renderer fetched `novaclaw.app/changelog.json` directly and cannot consult airgap policy: the
 * policy lives on the instance, and the renderer never reaches the wire.
 *
 * A/B: move the `checkUrl` call below the fetch and this fails on `calls`.
 *
 * ⚠️ `runSync`, deliberately, where every other test here uses `runPromise`. The refusal path must
 * do no asynchronous work at all, and `runSync` throws if it ever starts — a second, structural
 * proof that no request was made, independent of the `calls` array.
 */
test("🔴 an airgapped instance makes NO request at all", () => {
  const { fetcher, calls } = recordingFetcher("{}")
  const result = Effect.runSync(fetchChangelog(airgapped, fetcher))

  expect(result.kind).toBe("refused")
  // ⚠️ The assertion that matters is `calls`, not the verdict. A broker that fetched and then
  // discarded the answer would return exactly the same "refused" — and would already have told
  // `novaclaw.app` that this instance is running, which is the whole thing being fixed.
  expect(calls).toEqual([])
})

test("an open policy passes the upstream answer through untouched", async () => {
  const { fetcher, calls } = recordingFetcher('{"1.0.0":["a highlight"]}')
  const result = await Effect.runPromise(fetchChangelog(open, fetcher))

  expect(calls).toEqual(["https://novaclaw.app/changelog.json"])
  expect(result).toEqual({ kind: "answered", status: 200, body: '{"1.0.0":["a highlight"]}' })
})

/**
 * 🔴 The status is PASSED THROUGH, not interpreted.
 *
 * The caller's failure model turns on this: a 404 is an ANSWER, so it marks the version seen and
 * stops asking; a network silence is not, so it retries next launch. A broker that flattened both
 * into "unavailable" would make the app re-request a URL the host has said is not there, forever.
 */
test("🔴 a 404 arrives as a 404, not as an unavailability", async () => {
  const { fetcher } = recordingFetcher("not found", 404)
  const result = await Effect.runPromise(fetchChangelog(open, fetcher))
  expect(result).toEqual({ kind: "answered", status: 404, body: "not found" })
})

test("an upstream that never answers is reported as unreachable, with a reason", async () => {
  const fetcher = (async () => {
    throw new Error("getaddrinfo ENOTFOUND novaclaw.app")
  }) as unknown as typeof globalThis.fetch
  const result = await Effect.runPromise(fetchChangelog(open, fetcher))

  expect(result.kind).toBe("unreachable")
  expect(result.kind === "unreachable" && result.detail).toContain("ENOTFOUND")
})

/**
 * 🔴 An oversized body is refused, not truncated-and-served.
 *
 * The caller parses this as JSON. A truncated document either fails to parse — reported as
 * malformed, which is true but names the wrong culprit — or parses into something shorter than what
 * was actually published, which is worse because nothing looks wrong.
 *
 * A/B: return `read.text` regardless of `read.truncated` and this fails.
 */
test("🔴 an upstream body over the cap is unreachable, never a short answer", async () => {
  const { fetcher } = recordingFetcher("x".repeat(CHANGELOG_MAX_BYTES + 1024))
  const result = await Effect.runPromise(fetchChangelog(open, fetcher))

  expect(result.kind).toBe("unreachable")
  expect(result.kind === "unreachable" && result.detail).toContain("exceeded")
})

test("a body exactly at the cap is still a complete answer", async () => {
  // The boundary, in the direction that would silently lose the last byte of a legitimate document.
  const { fetcher } = recordingFetcher("x".repeat(CHANGELOG_MAX_BYTES))
  const result = await Effect.runPromise(fetchChangelog(open, fetcher))
  expect(result.kind).toBe("answered")
  expect(result.kind === "answered" && result.body.length).toBe(CHANGELOG_MAX_BYTES)
})

test("a host the policy allows is fetched even under airgap", async () => {
  // Airgap is a host allow-list, not a switch. If the user has allowed the host, the broker must not
  // add a second, stricter opinion of its own.
  const allowed: Offline.Policy = { enabled: true, allowedHosts: new Set(["novaclaw.app"]) }
  const { fetcher, calls } = recordingFetcher("{}")
  const result = await Effect.runPromise(fetchChangelog(allowed, fetcher))
  expect(calls).toHaveLength(1)
  expect(result.kind).toBe("answered")
})
