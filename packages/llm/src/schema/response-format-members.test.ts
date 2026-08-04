import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import { OpenAIChat } from "../protocols/openai-chat"
import { ResponseFormat, type LLMRequest } from "./messages"

/**
 * RULING 10, MECHANISED FOR `ResponseFormat` — *a thing needing new code stays a closed compiled set
 * **whose every member must be reachable***.
 *
 * The set declared `text | json | tool`. `tool` was reachable from nowhere: no producer existed in
 * either repo, `LLMRequest` is never decoded from a wire so no outside caller could build one, and
 * `LLM.generateObject` — the product's only structured-output entry point — `Omit`s `responseFormat`
 * from its options and forces the call with `toolChoice` instead. It shipped as a compiled member that
 * every reader had to reason about and nothing could ever exercise. It is deleted (2026-07-31).
 *
 * Deleting it is a one-time cleanup, and a one-time cleanup is not an invariant (ruling 1). This file
 * is the ratchet that makes it one. Three claims, each negative-controlled:
 *
 *   1. **The set is pinned.** Its members are read out of `messages.ts` itself, so ADDING one fails
 *      here rather than passing review. That is the point of failure a reviewer cannot supply: a new
 *      member compiles green everywhere, and the protocol that ignores it drops the caller's
 *      constraint in silence.
 *   2. **Every pinned member is REACHABLE through a real lowering.** Not "is declared" — driven
 *      through `OpenAIChat.protocol.body.from` until a `response_format` appears on the wire. A member
 *      that only decodes is exactly the thing this ruling forbids.
 *   3. **The deletion is real at the SCHEMA, not only in the source text.** `{type:"tool"}` no longer
 *      decodes, and an unexpressible member is refused by name rather than dropped (ruling 2).
 *
 * ⚠️ Claim 1 is a SOURCE assertion, deliberately. Effect's union AST is a private-ish shape that has
 * changed across betas, and a ratchet whose reader silently stops matching passes forever — so the
 * extractor below is itself negative-controlled against a synthetic three-member source.
 */

const SOURCE = readFileSync(join(import.meta.dir, "messages.ts"), "utf8")

/**
 * The `type` literals inside the `ResponseFormat` union declaration.
 *
 * Bounded to the declaration's own text — from `export const ResponseFormat = Schema.Union([` to the
 * closing `])` — so a `Schema.Literal` anywhere else in this 300-line file cannot leak in. Returns an
 * empty array when the block cannot be found, which claim 1's first assertion turns into a failure
 * rather than a vacuous pass.
 */
export const declaredMembers = (source: string): string[] => {
  const start = source.indexOf("export const ResponseFormat = Schema.Union([")
  if (start < 0) return []
  const end = source.indexOf("])", start)
  if (end < 0) return []
  return [...source.slice(start, end).matchAll(/Schema\.Literal\("([^"]+)"\)/g)].map((match) => match[1]!)
}

/** One legal value per member. A new member with no sample fails claim 2 as loudly as a missing arm. */
const SAMPLES: Record<string, Record<string, unknown>> = {
  text: { type: "text" },
  json: { type: "json", schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] } },
}

// Same minimal cast the protocol's own body tests use: `fromRequest` reads model/messages/tools/
// generation/responseFormat, so this drives real body construction without a live model.
const request = (patch: Record<string, unknown>) =>
  ({ model: { id: "qwen3.6-35b" }, system: [], messages: [], tools: [], ...patch }) as unknown as LLMRequest

const body = (patch: Record<string, unknown>) =>
  Effect.runSync(OpenAIChat.protocol.body.from(request(patch))) as Record<string, unknown>

const decodes = (value: unknown) =>
  Effect.runSyncExit(Schema.decodeUnknownEffect(ResponseFormat)(value))._tag === "Success"

describe("ResponseFormat is a CLOSED set and every member is reachable (ruling 10)", () => {
  test("the pinned member set — adding one fails here until it has a lowering", () => {
    // The ratchet's own reader must see something, or this file is a guard-shaped no-op.
    expect(
      declaredMembers(SOURCE).length,
      "could not read the ResponseFormat union out of messages.ts",
    ).toBeGreaterThan(0)
    expect(declaredMembers(SOURCE).sort()).toEqual(["json", "text"])
    // …and the sample table must cover the set exactly, so claim 2 below can never skip a member.
    expect(Object.keys(SAMPLES).sort()).toEqual(declaredMembers(SOURCE).sort())
  })

  test("NEGATIVE CONTROL: the extractor really reads members, and really sees a third one", () => {
    const synthetic = `export const ResponseFormat = Schema.Union([
      Schema.Struct({ type: Schema.Literal("text") }),
      Schema.Struct({ type: Schema.Literal("json"), schema: JsonSchema }),
      Schema.Struct({ type: Schema.Literal("tool"), tool: ToolDefinition }),
    ]).pipe(Schema.toTaggedUnion("type"))`
    expect(declaredMembers(synthetic)).toEqual(["text", "json", "tool"])
    // …and a source that does not declare the union at all yields nothing, which the first test
    // treats as a failure rather than as "no members, therefore fine".
    expect(declaredMembers('const Something = Schema.Literal("text")')).toEqual([])
  })

  test("every pinned member REACHES the wire — declared is not reachable", () => {
    for (const member of declaredMembers(SOURCE)) {
      const sample = SAMPLES[member]!
      const result = body({ responseFormat: sample })
      expect(result.response_format, `responseFormat \`${member}\` produced no response_format`).toBeDefined()
    }
  })

  test("NEGATIVE CONTROL: a member with no lowering is REFUSED BY NAME, never dropped (ruling 2)", () => {
    // This is the failure the pin exists to convert. `tool` is the deleted member, reached through a
    // cast — i.e. exactly how an undeclared member would arrive if someone added one to the schema
    // and forgot the protocol arm. The refusal must name it, so the report says which one.
    const error = Effect.runSync(
      OpenAIChat.protocol.body.from(request({ responseFormat: { type: "tool" } })).pipe(Effect.flip),
    )
    expect(error.reason).toMatchObject({ _tag: "InvalidRequest" })
    expect(String((error.reason as { message: string }).message)).toContain("responseFormat `tool`")
  })
})

describe("the deletion is real at the SCHEMA, not only in the source text", () => {
  test("the two live members decode", () => {
    expect(decodes({ type: "text" })).toBe(true)
    expect(decodes({ type: "json", schema: { type: "object" } })).toBe(true)
  })

  test("`tool` no longer decodes — the member is gone, not merely unlowered", () => {
    expect(decodes({ type: "tool", tool: { name: "write", description: "", inputSchema: {} } })).toBe(false)
    // NEGATIVE CONTROL for the decoder itself: it rejects other nonsense too, so the assertion above
    // is not passing because `decodes` always answers false.
    expect(decodes({ type: "json" })).toBe(false)
    expect(decodes({ type: "hologram" })).toBe(false)
  })
})
