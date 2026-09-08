import { describe, expect, test } from "bun:test"
import { englishI18n } from "@novaclaw/ui/context/i18n"

/** The row speaks the caller's language; the English translator makes these assertions readable. */
const t = englishI18n.t
import { colleagueRow } from "./colleague-row"

// The row a reader sees when their agent turns aside to talk to ANOTHER agent.
//
// 🔴 Owner, 2026-08-21: *"the user who reads the chat should clearly see that the agent got
// distracted and answered another agent."* Before this the `colleague` tool fell through to the
// default arm and rendered as the bare word `colleague` — the one row where the tool's NAME is the
// least interesting thing about it, and the fact the reader needs (their agent is working for
// someone else right now) was the part left out.

describe("the colleague row names who, and what was said", () => {
  test("a message leads with the recipient", () => {
    expect(colleagueRow({ op: "ask", colleague: "aris", message: "Where is the ledger?" }, t)).toEqual({
      title: "Messaged aris",
      subtitle: "Where is the ledger?",
    })
  })

  test('"Messaged", never "Asked" — the same op carries the answer', () => {
    // The reply travels back the way the question came (`core/session/colleague-note.ts`), so both
    // halves of an exchange are `op: ask`. A title claiming "Asked" would misdescribe every answer.
    const meta = colleagueRow({ op: "ask", colleague: "doriel", message: "Behind the clock." }, t)
    expect(meta.title).toBe("Messaged doriel")
    expect(meta.title).not.toContain("Asked")
  })

  test("staffing reads as staffing", () => {
    expect(colleagueRow({ op: "hire", title: "Bookkeeper" }, t).title).toBe("Hired a colleague")
    expect(colleagueRow({ op: "retire", colleague: "aris" }, t)).toEqual({
      title: "Retired a colleague",
      subtitle: "aris",
    })
    expect(colleagueRow({ op: "list" }, t).title).toBe("Looked up colleagues")
  })

  test("a nameless recipient is still legible, never blank", () => {
    expect(colleagueRow({ op: "ask" }, t).title).toBe("Messaged a colleague")
  })

  test("NEGATIVE CONTROL: a subtitle is omitted, never blank", () => {
    // An empty string would render an empty second line — a row that looks broken rather than terse.
    expect(colleagueRow({ op: "ask", colleague: "aris", message: "" }, t)).toEqual({ title: "Messaged aris" })
    expect(colleagueRow({}, t)).toEqual({ title: "Messaged a colleague" })
  })
})
