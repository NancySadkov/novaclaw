import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ToolFailure } from "@novaclaw/llm"
import { Durable } from "../session/durable"
import type { SessionComponentRegistry } from "../session/component-registry"
import type { SessionSchema } from "../session/schema"
import { MemoTool } from "./memo"
import type { Tool } from "./tool"

/**
 * The memo tool's REFUSALS, at the tool seam.
 *
 * 🔴 The pure notices are pinned in `session/durable.test.ts`; this file is the other half of the
 * claim — that `memo_set` actually RETURNS them, so the model sees a message that names the limit and
 * the way forward instead of dying inside the storage layer. Owner, 2026-09-19: at the eleventh memo
 * the agent must be told to `memo_clear` one first, and an over-long name or value must be named
 * against the 30/512 limits, "since context space is extremely valuable".
 */

const sessionID = "ses_memo_test" as SessionSchema.ID
const context = { sessionID } as unknown as Tool.Context

const item = (name: string, value: string) => ({ id: Durable.keyOf(name), value: { name, value } })

/** A registry stub: enough of the Interface for the tool's happy and refusal paths, nothing else. */
const stub = (rows: ReadonlyArray<{ id: string; value: unknown }>) => {
  const written: Array<{ id: string | undefined; value: unknown }> = []
  const components = {
    list: () => Effect.succeed(rows),
    validate: (input: { value: unknown }) => Effect.succeed(input.value as never),
    put: (input: { id?: string; value: unknown }) => {
      written.push({ id: input.id, value: input.value })
      return Effect.succeed(undefined as never)
    },
    get: () => Effect.succeed(undefined),
    remove: () => Effect.succeed(false),
    validateRemoval: () => Effect.void,
  } as unknown as SessionComponentRegistry.Interface
  return { components, written }
}

const refusal = (components: SessionComponentRegistry.Interface, input: MemoTool.SetInput) =>
  Effect.runPromise(Effect.flip(MemoTool.setMemo({ components }, input, context)))

describe("memo_set — the agent is told the limit and the way through it", () => {
  test("an eleventh memo says the area is full and names `memo_clear` before the existing items", async () => {
    const rows = Array.from({ length: Durable.DURABLE_ITEMS_MAX }, (_, index) =>
      item(`item-${index}`, `value ${index}`),
    )
    const { components } = stub(rows)
    const error = await refusal(components, { name: "eleventh", value: "x" })

    expect(error).toBeInstanceOf(ToolFailure)
    expect(error.message).toContain("full")
    expect(error.message).toContain(`${Durable.DURABLE_ITEMS_MAX} of ${Durable.DURABLE_ITEMS_MAX}`)
    expect(error.message).toContain("memo_clear NAME")
    // The menu it hands back is what makes the choice the agent's rather than the harness's.
    expect(error.message).toContain("item-0")
    expect(error.message).toContain("item-9")
  })

  test("reusing a name at the limit REPLACES rather than refusing, because no new slot is needed", async () => {
    const rows = Array.from({ length: Durable.DURABLE_ITEMS_MAX }, (_, index) => item(`item-${index}`, `v${index}`))
    const { components, written } = stub(rows)
    const output = await Effect.runPromise(MemoTool.setMemo({ components }, { name: "item-3", value: "new" }, context))

    expect(output.message).toContain("Replaced")
    expect(written).toHaveLength(1)
  })

  test("an over-long name names the 30-character limit and the context-space reason", async () => {
    const { components, written } = stub([])
    const error = await refusal(components, { name: "n".repeat(Durable.DURABLE_NAME_MAX + 1), value: "v" })

    expect(error).toBeInstanceOf(ToolFailure)
    expect(error.message).toContain(String(Durable.DURABLE_NAME_MAX))
    expect(error.message).toContain("extremely valuable")
    expect(written).toHaveLength(0)
  })

  test("an over-long value names the 512-character limit and points at a file", async () => {
    const { components, written } = stub([])
    const error = await refusal(components, { name: "Big", value: "v".repeat(Durable.DURABLE_VALUE_MAX + 1) })

    expect(error).toBeInstanceOf(ToolFailure)
    expect(error.message).toContain(String(Durable.DURABLE_VALUE_MAX))
    expect(error.message).toContain("extremely valuable")
    expect(error.message).toContain("file")
    expect(written).toHaveLength(0)
  })

  test("a successful write says the memo appears only after the compaction", async () => {
    const { components, written } = stub([])
    const output = await Effect.runPromise(MemoTool.setMemo({ components }, { name: "Path", value: "C:/books" }, context))

    expect(output.message).toContain("will appear in system prompt after the compaction")
    expect(output.message).toContain(`1 of ${Durable.DURABLE_ITEMS_MAX}`)
    expect(written).toHaveLength(1)
  })
})
