import { describe, expect, test } from "bun:test"
import { todoDockAtBoundary, todoState } from "./session-composer-todo"

describe("todoState", () => {
  test("hides when there are no todos", () => {
    expect(todoState({ count: 0, done: false, live: true })).toBe("hide")
  })

  test("opens while the session is still working", () => {
    expect(todoState({ count: 2, done: false, live: true })).toBe("open")
  })

  test("closes completed todos after a running turn", () => {
    expect(todoState({ count: 2, done: true, live: true })).toBe("close")
  })

  test("clears stale todos when the turn ends", () => {
    expect(todoState({ count: 2, done: false, live: false })).toBe("clear")
  })

  test("clears completed todos when the session is no longer live", () => {
    expect(todoState({ count: 2, done: true, live: false })).toBe("clear")
  })
})

describe("todoDockAtBoundary", () => {
  test("shows active todos when entering a session", () => {
    expect(todoDockAtBoundary("open")).toBe(true)
  })

  test("hides completed todos when entering a session", () => {
    expect(todoDockAtBoundary("close")).toBe(false)
  })
})
