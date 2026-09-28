import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { chatFor } from "@/apps/roster-live"

const here = dirname(fileURLToPath(import.meta.url))
const strip = readFileSync(join(here, "..", "components", "titlebar-tab-strip.tsx"), "utf8")

/**
 * 🔴 AN AGENT TAB IS ADDRESSED BY ITS COLLEAGUE — BUT ITS BADGES ARE STILL ABOUT A CHAT.
 *
 * The title bar is agent-addressed (a tab is `/server/<key>/agent/<agentID>`, and the chat is a
 * component reached through the colleague), so the strip builds each agent tab from a stub rather
 * than a session record. That stub carried `id: ""`, and the strip passed it straight to every
 * per-session reader hanging off the tab — the working dot among them, which asks
 * `session_working(id)` → `session_status[id]`. So the dot asked about session `""`, got `undefined`,
 * and stayed dark for every colleague on every tab, forever.
 *
 * Measured 2026-09-26 in the packaged release build: `ses_nova` `busy/provider` for 17 s, the
 * composer reading Stop, and the pulsing dot absent in 10 of 10 samples.
 *
 * ⚠️ The empty id is not the whole story and must not become an alibi: it is legal as a FALLBACK,
 * for the window before a colleague's chat is known. What is not legal is a tab that never asks the
 * colleague. So the assertions below are about the QUESTION being asked, not about the string.
 */
describe("agent tab session identity", () => {
  test("the strip asks the colleague which chat it is standing for", () => {
    // Not a style rule: with the lookup gone, `id: ""` becomes the only answer again and the dot
    // goes dark with no test failing anywhere.
    expect(strip).toMatch(/chatFor\(/)
    expect(strip).toMatch(/colleagueChat\(\)\s*\?\?/)
  })

  test("the colleague's chat is what an agent tab reports, not a blank id", () => {
    // The behaviour, against the real resolver: an agent tab asked about its colleague gets the live
    // chat, so `session_working` has a session to answer for.
    const rows = [
      { id: "ses_old", agent: "nova", time: { created: 1 }, archived: 2 },
      { id: "ses_live", agent: "nova", time: { created: 5 } },
    ] as never
    expect(chatFor(rows, "nova")?.id).toBe("ses_live")
    // And a colleague with no chat at all resolves to nothing, which is what the stub is for.
    expect(chatFor(rows, "nobody")).toBeUndefined()
  })

  test("the stub remains only as the fallback, never as the answer", () => {
    const stub = /id:\s*""/
    expect(stub.test(strip)).toBe(true)
    // Every `id: ""` in the strip must sit behind the colleague lookup on the same expression.
    const answers = strip.match(/return\s*\(?\s*colleagueChat\(\)[\s\S]*?id:\s*""[^\n]*/g) ?? []
    expect(answers.length).toBe(1)
    expect(answers[0]).toMatch(/colleagueChat\(\)\s*\?\?/)
  })
})
