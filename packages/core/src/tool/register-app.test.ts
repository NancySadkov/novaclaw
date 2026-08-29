import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Input, openFromInput } from "./register-app"

const decode = Schema.decodeUnknownSync(Input)

describe("register-app route contract", () => {
  test("the model-facing schema offers only build-owned route ids", () => {
    expect(decode({ title: "Files shortcut", open_type: "route", route_id: "files" }).route_id).toBe("files")
    expect(() => decode({ title: "Stocks", open_type: "route", route_id: "stocks" })).toThrow()
    expect(() => decode({ title: "Old path", open_type: "route", route_id: "/files" })).toThrow()
  })

  test("route launchers persist the selected id, never a free-form value", () => {
    expect(openFromInput({ open_type: "route", route_id: "contacts" })).toEqual({
      type: "route",
      value: "contacts",
    })
    expect(() => openFromInput({ open_type: "route" })).toThrow(/requires route_id.*contacts.*files/)
  })

  test("URL and prompt launchers keep their separate value field", () => {
    expect(openFromInput({ open_type: "url", open_value: "https://example.test" })).toEqual({
      type: "url",
      value: "https://example.test",
    })
    expect(openFromInput({ open_type: "prompt", open_value: "Summarize my notes" })).toEqual({
      type: "prompt",
      value: "Summarize my notes",
    })
    expect(() => openFromInput({ open_type: "prompt" })).toThrow(/requires open_value/)
  })
})
