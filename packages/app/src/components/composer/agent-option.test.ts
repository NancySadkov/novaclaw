import { describe, expect, test } from "bun:test"
import { selectedOption, type ComposerAgentControlState } from "./agent-option"

// WHO the prompt is for (owner, 2026-08-21: an agent selector in the prompt area, instead of a
// folder selector). The rendering is a `<select>`; what needs a test is which colleague it resolves
// to, because "nothing selected" and "the first one" are different facts and the chip must not
// silently address the wrong desk.

const option = (id: string, folder = `/scratch/${id}`, ownScratch = true) => ({
  id,
  name: id[0]!.toUpperCase() + id.slice(1),
  folder,
  ownScratch,
})

const state = (over: Partial<ComposerAgentControlState>): ComposerAgentControlState => ({
  options: [option("nova"), option("theron", "D:/books", false)],
  selectedID: undefined,
  working: false,
  onSelect: () => {},
  ...over,
})

describe("which colleague the chip is addressing", () => {
  test("the chosen one when there is a choice", () => {
    expect(selectedOption(state({ selectedID: "theron" }))?.id).toBe("theron")
  })

  test("the FIRST when nothing has been chosen — never nobody", () => {
    // The bar's click creates a chat; resolving to `undefined` would mean the click either does
    // nothing or silently picks for the user without the chip agreeing.
    expect(selectedOption(state({}))?.id).toBe("nova")
  })

  test("an id that is no longer on the roster falls back rather than addressing nobody", () => {
    // A colleague retired in another window is the live case: the chip's stored id outlives the row.
    expect(selectedOption(state({ selectedID: "retired_last_week" }))?.id).toBe("nova")
  })

  test("an empty roster resolves to nothing, and the control renders nothing", () => {
    // Distinct from the case above: with nobody to address, a fallback would be an invention.
    expect(selectedOption(state({ options: [] }))).toBeUndefined()
  })
})

describe("the chip's two shapes", () => {
  test("in a CHAT it is identity, not a picker", () => {
    // 🔴 A chat belongs to one colleague ("a single compactable chat per agent"), so a mid-chat agent
    // switch would hand somebody else's transcript to a different officer — the confusion the roster
    // removed. The flag is what makes that structural rather than a convention.
    const chat = state({ selectedID: "theron", readOnly: true })
    expect(chat.readOnly).toBe(true)
    expect(selectedOption(chat)?.name).toBe("Theron")
  })

  test("on the HOME bar it is a choice, and defaults to somebody", () => {
    const bar = state({})
    expect(bar.readOnly).toBeUndefined()
    expect(selectedOption(bar)?.id).toBe("nova")
  })
})
