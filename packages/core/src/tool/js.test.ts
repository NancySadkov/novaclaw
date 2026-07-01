import { describe, expect, test } from "bun:test"
import { toModelOutput } from "./js"

describe("js tool toModelOutput", () => {
  test("value with console output", () => {
    expect(toModelOutput({ ok: true, result: "14", logs: ["debug 7"] })).toBe("debug 7\n=> 14")
  })

  test("value without logs", () => {
    expect(toModelOutput({ ok: true, result: "42", logs: [] })).toBe("=> 42")
  })

  test("undefined result renders explicitly", () => {
    expect(toModelOutput({ ok: true, logs: [] })).toBe("=> undefined")
  })

  test("error is surfaced", () => {
    expect(toModelOutput({ ok: false, error: "Error: boom", timedOut: false, logs: [] })).toBe("Error: Error: boom")
  })

  test("timeout keeps any prior console output", () => {
    expect(
      toModelOutput({ ok: false, error: "Execution timed out after 5s", timedOut: true, logs: ["step 1"] }),
    ).toBe("step 1\nError: Execution timed out after 5s")
  })
})
