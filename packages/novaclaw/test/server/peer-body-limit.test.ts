import { describe, expect, test } from "bun:test"
import { CommunityPeerPaths } from "../../src/server/routes/instance/httpapi/groups/community"
import { MAX_PEER_REQUEST_BYTES, refusesBody } from "../../src/server/routes/instance/httpapi/middleware/peer-body-limit"

/**
 * 🔴 The community peer endpoints are the only unauthenticated door this server has, and until this
 * middleware existed nothing bounded what could be POSTed through it.
 *
 * Found by probing a running instance, not by any test — and it sat BENEATH every other bound in the
 * subsystem, which is why none of them caught it: `MAX_BODY_BYTES` (8 KB), `MAX_MESSAGES_PER_REQUEST`
 * (256) and `MAX_CHANNEL_BYTES` (256) are all checked after the body is buffered and parsed. A
 * 52.9 MB POST returned **200 OK** and cost **+450 MB** of commit charge; with the middleware it is
 * a 413 costing nothing, measured the same way on the same server.
 */
describe("peer body limit", () => {
  const big = String(MAX_PEER_REQUEST_BYTES + 1)

  test("🔴 every unauthenticated peer path is covered, derived rather than listed", () => {
    // ⚠️ Derived from `CommunityPeerPaths`, so a peer endpoint added later cannot quietly arrive
    // without a limit. A hand-maintained list is the mistake the `/api` auth guard made three times.
    for (const path of Object.values(CommunityPeerPaths)) expect(refusesBody("POST", path, big)).toBe(true)
  })

  test("🔴 a request with NO content-length is refused, not read hopefully", () => {
    // The check has to happen BEFORE the allocation it exists to prevent, and an absent header is
    // the one case where the size cannot be known in time.
    expect(refusesBody("POST", CommunityPeerPaths.syncIds, undefined)).toBe(true)
    expect(refusesBody("POST", CommunityPeerPaths.syncIds, "not-a-number")).toBe(true)
  })

  test("🔴 a query string cannot smuggle a peer path past the set", () => {
    expect(refusesBody("POST", `${CommunityPeerPaths.inbound}?x=1`, big)).toBe(true)
  })

  test("ordinary peer traffic is untouched, and the app API is not capped here", () => {
    // The largest legitimate peer request is `sync/messages` at 256 ids of 64 hex characters —
    // about 17 KB — so real traffic is nowhere near the limit.
    expect(refusesBody("POST", CommunityPeerPaths.syncMessages, "20000")).toBe(false)
    // ⚠️ The authenticated app API is deliberately NOT capped by this middleware: different traffic,
    // different question, and a silent cap there would surface later as a mysterious failure.
    expect(refusesBody("POST", "/api/session", big)).toBe(false)
    expect(refusesBody("GET", CommunityPeerPaths.peers, big)).toBe(false)
  })
})
