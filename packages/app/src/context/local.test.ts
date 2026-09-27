import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

/**
 * 🔴 **THE GHOST, AT ITS LAST WRITER.**
 *
 * Owner, 2026-09-27: *"they are not just ghosts polluting NovaClaw"*, after seeing `build` and `plan`
 * in a `colleague list` — and both had been named and titled by the previous slice, which is what made
 * them look like colleagues rather than leftovers.
 *
 * The chain, and the part that is a defect rather than machinery:
 *
 * 1. `local.tsx` filtered the roster with `mode !== "subagent" && !item.hidden` — **no posture clause**.
 * 2. The source it reads is the legacy `GET /agent` projection, a literal that lists `build` FIRST.
 * 3. So `list()[0]` was `build`, `store.current` was initialised from it, and
 *    `prompt-input/submit.ts` sent `agent: "build"` in the create body for **every chat the composer
 *    made**. The file's own comment already named `items[0]` as `build` and blamed it for chats
 *    belonging to Umbris ending up running as `build` — and left it in place.
 *
 * ⚠️ The kernel refuses the alternative outright rather than defaulting: `createSessionRecord` returns
 * `OwnerRequiredError` for a root with no agent, because *"defaulting to a posture reintroduces exactly
 * the ghost `DEFAULT_COLLEAGUE_ID` was moved OFF `build` to remove"*. So the composer was the last
 * door still producing posture-owned chats, and it is the reason `build` cannot simply be deleted yet.
 *
 * This is a source ledger because the value is a filter over a store-backed query: exercising it needs
 * a live sync, a server scope and a persisted store. What is checkable is that the three facts hold —
 * and all three have been individually load-bearing.
 */
describe("the composer's default chat belongs to a colleague", () => {
  const source = readFileSync(new URL("./local.tsx", import.meta.url), "utf8")
  const list = source.slice(source.indexOf("const list = createMemo"), source.indexOf("const connected = createMemo"))

  test("🔴 the posture ids are filtered out of the composer's agent list", () => {
    expect(list).toContain("AgentV2.POSTURE_IDS.has(item.name)")
    // The hand-rolled pair that let it through.
    expect(list).not.toContain('item.mode !== "subagent" && !item.hidden)')
  })

  test("🔴 the GOVERNING officer leads, so this door and the home launcher's agree", () => {
    // Two doors onto "whose chat is a new one" that answered differently — the launcher picked
    // `DEFAULT_COLLEAGUE_ID`, this picked whatever sorted first. The roster already paid for that once
    // (measured 2026-08-21: a chat made from the roster while the composer said "Build").
    expect(list).toContain("AgentV2.DEFAULT_COLLEAGUE_ID")
    expect(source).toContain('import { AgentV2 } from "@novaclaw/core/agent"')
  })

  test("…and the launcher it is matched against still says the same thing", () => {
    const launcher = readFileSync(
      new URL("../pages/home-screen/new-agent-bar.tsx", import.meta.url),
      "utf8",
    )
    expect(launcher).toContain("AgentV2.DEFAULT_COLLEAGUE_ID")
  })

  /**
   * A stale browser preference must not be able to bring a posture back. The `createEffect` that
   * repairs `store.current` is pre-existing and correct — it already replaces a name that is no longer
   * in the list — so the posture clause is enough. This pins that the repair is still there, because
   * without it a browser that had `build` persisted would simply keep writing `build`.
   */
  test("a persisted preference that is no longer a colleague is replaced, not reused", () => {
    expect(source).toContain("if (items.some((item) => item.name === store.current)) return")
    expect(source).toContain('setStore("current", items[0]?.name)')
  })
})
