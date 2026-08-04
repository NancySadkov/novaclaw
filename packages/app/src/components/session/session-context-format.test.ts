import { describe, expect, it } from "bun:test"
import { createSessionContextFormatter } from "./session-context-format"

// Regression (owner-hit 2026-07-24, clicking the context gauge ring): a `time.created` fed to the
// formatter can be an ISO STRING, not epoch millis — the live SSE mirror carries Type-side DateTime
// and native message times aren't run through `normalizeSessionTimes`. `DateTime.fromMillis` threw
// on the string ("fromMillis requires a numerical input …"), faulting the whole context tab. The
// formatter must tolerate both encodings.
describe("createSessionContextFormatter.time", () => {
  const fmt = createSessionContextFormatter("en-US")

  it("formats epoch millis", () => {
    expect(fmt.time(Date.parse("2026-07-24T01:45:56.545Z"))).not.toBe("—")
  })

  it("tolerates an ISO string (the SSE Type-side leak) without throwing", () => {
    const iso = "2026-07-24T01:45:56.545Z"
    expect(() => fmt.time(iso)).not.toThrow()
    // Same instant, either encoding → identical output.
    expect(fmt.time(iso)).toBe(fmt.time(Date.parse(iso)))
    expect(fmt.time(iso)).not.toBe("—")
  })

  it("renders a dash for empty/invalid times", () => {
    expect(fmt.time(undefined)).toBe("—")
    expect(fmt.time(null)).toBe("—")
    expect(fmt.time("")).toBe("—")
    expect(fmt.time(0)).toBe("—")
    expect(fmt.time("not-a-date")).toBe("—")
  })
})
