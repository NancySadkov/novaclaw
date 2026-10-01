import { describe, expect, test } from "bun:test"
import { AgentV2 } from "../agent"
import { refusal } from "./colleague-message-rate"

const roster = [
  { id: "nova" },
  { id: "aris", superior: "nova" },
  { id: "theron", superior: "nova" },
  { id: "iris", superior: "aris" },
  { id: "owner", kind: "human" },
] as unknown as AgentV2.Info[]

const now = 4_000_000
const check = (
  sender: string,
  recipients: string[],
  messages: Array<{ sender: string; recipient: string; at: number }>,
  intervals = {},
) => refusal({ sender, recipients, roster, messages, intervals, now })

describe("colleague message interval", () => {
  test("limits both outgoing and incoming peer messages for 60 minutes by default", () => {
    expect(check("aris", ["theron"], [])).toBeUndefined()
    const prior = [{ sender: "aris", recipient: "theron", at: now - 59 * 60_000 }]
    expect(check("aris", ["nova"], prior)).toBe("Rate-limit 1 message per 60 minutes - respect everyone's time.")
    expect(check("nova", ["theron"], prior)).toBeUndefined()
    expect(check("iris", ["theron"], prior)).toBe("Rate-limit 1 message per 60 minutes - respect everyone's time.")
    expect(check("aris", ["theron"], [{ ...prior[0]!, at: now - 60 * 60_000 }])).toBeUndefined()
  })

  test("uses each officer's configured interval", () => {
    const prior = [{ sender: "aris", recipient: "theron", at: now - 10 * 60_000 }]
    expect(check("aris", ["nova"], prior, { aris: 5 })).toBeUndefined()
    expect(check("iris", ["theron"], prior, { theron: 15 })).toBe(
      "Rate-limit 1 message per 15 minutes - respect everyone's time.",
    )
  })

  test("direct superior messages neither hit nor spend either officer's limit", () => {
    const prior = [{ sender: "nova", recipient: "aris", at: now - 1000 }]
    expect(check("nova", ["aris", "theron"], prior)).toBeUndefined()
    expect(check("aris", ["theron"], prior)).toBeUndefined()
    expect(check("aris", ["iris"], prior)).toBeUndefined()
  })

  test("one group send counts once outbound and once for each recipient", () => {
    expect(check("aris", ["theron", "nova"], [])).toBeUndefined()
  })

  test("the human owner has no incoming officer rate limit", () => {
    const prior = [{ sender: "aris", recipient: "owner", at: now - 1000 }]
    expect(check("theron", ["owner"], prior)).toBeUndefined()
  })
})
