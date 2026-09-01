import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

/**
 * 🔴 **The permanent private fork of `@modelcontextprotocol/sdk` has to fail HERE, not in a user's
 * session.**
 *
 * `patches/@modelcontextprotocol%2Fsdk@1.29.0.patch` adds MCP session recovery: a client whose
 * server has forgotten its session id re-initialises and replays, instead of surfacing the failure
 * to the agent mid-turn. The patch touches **twelve `dist/` files and zero `src/`**, which is what
 * makes it fragile — a version bump silently produces an unpatched install, and nothing in this
 * repository references the symbols it adds, so no ordinary test would notice.
 *
 * ⚠️ **That absence is the whole point.** The recovery is INTERNAL to the SDK: our code calls the
 * ordinary client API and the patch changes what that API does on an expired session. So there is no
 * call site to assert against, and "no caller" here means *the guard has to be about the artifact*
 * rather than about our usage — the one case where checking an installed file is the right test and
 * not a lazy one.
 *
 * ⚠️ **A `bun install` that drops the patch is the failure this catches**, and it is silent by
 * construction: the install succeeds, the types are unchanged, the typecheck is green, and the first
 * symptom is a user's MCP session dying after the server restarts.
 *
 * **If this goes red:** do not delete it and do not weaken it to a substring that still matches.
 * Either the patch stopped applying (re-apply it, or re-cut it against the new version) or upstream
 * shipped recovery itself — in which case retire the patch AND this test in the same change, and say
 * which upstream version made it redundant.
 */

/** Resolved through the package's own exports, so a hoisting or store-layout change cannot make this
 *  test quietly assert nothing by reading a path that no longer exists. */
const sdkFile = (specifier: string): string => {
  const resolved = Bun.resolveSync(specifier, import.meta.dir)
  return readFileSync(resolved, "utf8")
}

describe("the MCP SDK fork's surface survives the install", () => {
  test("session recovery is present in the installed client", () => {
    const streamableHttp = sdkFile("@modelcontextprotocol/sdk/client/streamableHttp.js")
    const client = sdkFile("@modelcontextprotocol/sdk/client/index.js")

    // The two halves the patch adds: the transport's recovery routine, and the hook the client
    // fires when the far side reports the session gone.
    expect(streamableHttp, "the transport lost `_recoverSession` — the fork did not apply").toContain(
      "_recoverSession",
    )
    expect(streamableHttp, "the transport lost `onsessionexpired` — the fork did not apply").toContain(
      "onsessionexpired",
    )
    expect(client, "the client lost `onsessionexpired` — the fork did not apply").toContain("onsessionexpired")
  })

  test("the scan is reading a real module, not an empty string", () => {
    // ⚠️ Vacuity guard, in the shape this repo uses for every source-scanning ratchet: a resolver
    // change or a moved entry point would make `toContain` assert against "" forever. Anchored on a
    // symbol that is UPSTREAM's, not ours, so it stays true across re-cuts of our patch.
    const streamableHttp = sdkFile("@modelcontextprotocol/sdk/client/streamableHttp.js")
    expect(streamableHttp.length).toBeGreaterThan(1_000)
    expect(streamableHttp).toContain("StreamableHTTPClientTransport")
  })
})
