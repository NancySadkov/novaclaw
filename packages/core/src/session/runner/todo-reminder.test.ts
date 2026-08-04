import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { Token } from "../../util/token"
import { STEER_PROVENANCE_PREFIX } from "../steer-provenance"
import { TodoReminder } from "./todo-reminder"

const todo = (content: string, status = "pending", priority = "medium") => ({ content, status, priority })

describe("TodoReminder Tune", () => {
  test("defaults are useful and unsafe direct values are clamped", () => {
    expect(TodoReminder.resolve(undefined)).toEqual({ enabled: true, cadence: 6, maxTokens: 256 })
    expect(TodoReminder.resolve({ enabled: false, cadence: 0.2, max_tokens: 1 })).toEqual({
      enabled: false,
      cadence: 1,
      maxTokens: 64,
    })
    expect(TodoReminder.resolve({ cadence: 99_999, max_tokens: 99_999 })).toEqual({
      enabled: true,
      cadence: 1000,
      maxTokens: 4096,
    })
  })

  test("durable sequence buckets fire once and survive compaction-shaped sequence reuse", () => {
    const config = { cadence: 6 }
    expect(TodoReminder.due(5, config, undefined)).toBeUndefined()
    const second = TodoReminder.due(12, config, undefined)
    expect(second).toEqual({ cadence: 6, bucket: 2 })
    // A compaction overlay carries the prefix seq, so observing that same latest seq is not a new cadence.
    expect(TodoReminder.due(12, config, second)).toBeUndefined()
    expect(TodoReminder.due(17, config, second)).toBeUndefined()
    expect(TodoReminder.due(18, config, second)).toEqual({ cadence: 6, bucket: 3 })
    // The Tune applies live: a changed cadence cannot collide with an old bucket carrying the same number.
    expect(TodoReminder.due(12, { cadence: 5 }, second)).toEqual({ cadence: 5, bucket: 2 })
  })

  test("empty checklists stay inert", () => {
    expect(TodoReminder.render([], 256)).toBeUndefined()
  })

  test("active and high-priority work wins the projection budget", () => {
    const rendered = TodoReminder.render(
      [
        todo("already shipped", "completed", "low"),
        todo("ordinary follow-up", "pending", "low"),
        todo("fix the active blocker", "in_progress", "high"),
        todo("important next step", "pending", "high"),
      ],
      256,
    )!
    expect(rendered).toStartWith(STEER_PROVENANCE_PREFIX)
    expect(rendered.indexOf("fix the active blocker")).toBeLessThan(rendered.indexOf("important next step"))
    expect(rendered.indexOf("important next step")).toBeLessThan(rendered.indexOf("ordinary follow-up"))
    expect(rendered.indexOf("ordinary follow-up")).toBeLessThan(rendered.indexOf("already shipped"))
    expect(rendered).toContain("`todowrite`")
  })

  test("the CJK-aware budget is hard and names omitted checklist items", () => {
    const rendered = TodoReminder.render(
      [
        todo("最優先の作業を続けて検証する".repeat(30), "in_progress", "high"),
        todo("second item", "pending", "medium"),
        todo("third item", "completed", "low"),
      ],
      64,
    )!
    expect(Token.estimate(rendered)).toBeLessThanOrEqual(64)
    expect(rendered).toContain("[in progress]")
    expect(rendered).toContain("2 more checklist items omitted")
    expect(rendered).not.toContain("second item")
  })
})

describe("runner composition", () => {
  const source = readFileSync(new URL("./llm.ts", import.meta.url), "utf8")

  test("reads the durable todo table only when a cadence bucket is due", () => {
    const due = source.indexOf("const reminderState = TodoReminder.due(")
    const read = source.indexOf("yield* SessionTodo.readTodos(db, session.id)", due)
    expect(due).toBeGreaterThan(0)
    expect(read).toBeGreaterThan(due)
  })

  test("projects the reminder into the provider request without writing a transcript message", () => {
    expect(source).toContain("[Message.user(todoReminder)]")
    expect(source).not.toContain("SessionInput.steer(db, events, session.id, todoReminder)")
  })
})
