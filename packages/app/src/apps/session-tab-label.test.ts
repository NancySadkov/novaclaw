import { describe, expect, test } from "bun:test"
import { idToName, tabLabel } from "./session-tab-label"

const agents = [
  { id: "iris", name: "Iris" },
  { id: "nova", name: "Nova" },
  { id: "fleet_coordinator", name: "" },
]

describe("tabLabel", () => {
  test("a chat with a colleague is named after the colleague, not its topic", () => {
    expect(tabLabel({ agent: "iris", title: "Fix the parser crash", agents })).toEqual({
      text: "Iris",
      tooltip: "Fix the parser crash",
      renameable: false,
    })
  })

  test("the topic survives as the tooltip, and never repeats the label", () => {
    expect(tabLabel({ agent: "iris", title: "Iris", agents }).tooltip).toBeUndefined()
    expect(tabLabel({ agent: "iris", title: "  ", agents }).tooltip).toBeUndefined()
    expect(tabLabel({ agent: "iris", title: undefined, agents }).tooltip).toBeUndefined()
  })

  test("a chat with NO colleague keeps its title, and stays renameable", () => {
    // The fallback is the whole reason this is a function: a pre-roster session, an integration's
    // session, or a sub-agent thread opened directly has nobody to be named after.
    expect(tabLabel({ agent: undefined, title: "Refactor the exporter", agents })).toEqual({
      text: "Refactor the exporter",
      tooltip: undefined,
      renameable: true,
    })
    expect(tabLabel({ agent: "   ", title: "Refactor the exporter", agents }).renameable).toBe(true)
  })

  test("an agent the client has not loaded (or one that was retired) still names its tab", () => {
    // ⚠️ The roster arrives after the tab strip paints. A blank tab in that window would read as a
    // broken chat, and a retired colleague's still-open chat must not blank either.
    expect(tabLabel({ agent: "theron", title: "Books", agents: [] })).toEqual({
      text: "Theron",
      tooltip: "Books",
      renameable: false,
    })
  })

  test("a colleague whose record carries an empty name falls back to its id, title-cased", () => {
    expect(tabLabel({ agent: "fleet_coordinator", title: "x", agents }).text).toBe("Fleet Coordinator")
  })

  test("idToName splits on every separator the ids actually use", () => {
    expect(idToName("smoke_aris")).toBe("Smoke Aris")
    expect(idToName("fleet-coordinator")).toBe("Fleet Coordinator")
    expect(idToName("nova")).toBe("Nova")
    // Degenerate input returns the id rather than "": a tab with no text is not a better outcome.
    expect(idToName("__")).toBe("__")
  })
})
