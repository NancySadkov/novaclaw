import { describe, expect, test } from "bun:test"
import { AgentV2 } from "@novaclaw/core/agent"

const officer = (id: string, superior?: string) =>
  AgentV2.Info.make({
    id: AgentV2.ID.make(id),
    request: { headers: {}, body: {} },
    mode: "primary",
    hidden: false,
    permissions: [],
    ...(superior === undefined ? {} : { superior: AgentV2.ID.make(superior) }),
  })

describe("officer hierarchy", () => {
  test("absent defaults to Nova and a valid intermediate superior survives", () => {
    const roster = [officer("nova"), officer("theron"), officer("iris", "theron")]
    expect(String(AgentV2.resolveSuperior("theron", undefined, roster)?.id)).toBe("nova")
    expect(String(AgentV2.resolveSuperior("iris", AgentV2.ID.make("theron"), roster)?.id)).toBe("theron")
  })

  test("self, missing, and cyclic reporting lines fall back to Nova", () => {
    const roster = [officer("nova"), officer("iris", "theron"), officer("theron", "iris")]
    expect(String(AgentV2.resolveSuperior("iris", AgentV2.ID.make("iris"), roster)?.id)).toBe("nova")
    expect(String(AgentV2.resolveSuperior("iris", AgentV2.ID.make("missing"), roster)?.id)).toBe("nova")
    expect(String(AgentV2.resolveSuperior("iris", AgentV2.ID.make("theron"), roster)?.id)).toBe("nova")
  })

  test("Nova has no superior", () => {
    expect(AgentV2.resolveSuperior("nova", AgentV2.ID.make("iris"), [officer("nova"), officer("iris")])).toBeUndefined()
  })
})
