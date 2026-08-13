import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import { request as makeRequest } from "../llm"
import { Model, ToolDefinition } from "../schema"
import { AnthropicMessages } from "./anthropic-messages"
import { Gemini } from "./gemini"
import { OpenAIChat } from "./openai-chat"
import { OpenAIResponses } from "./openai-responses"

/**
 * EVERY protocol lowers the prompted channel, or the switch is half applied.
 *
 * 🔴 The hazard is the one `project-defaults.ts` names for session components, one level up: a
 * channel honoured by some protocols and ignored by others means a model configured `prompted` on
 * an unwired wire silently keeps its native tools — while Settings, reading the same config, says
 * `prompted`. The user is then told the opposite of what is happening, on the screen they opened to
 * find out.
 *
 * ⚠️ It is invisible to behaviour: the unwired protocol keeps WORKING (native tools function), so
 * nothing fails. Only a body inspection shows it.
 */

const tool = ToolDefinition.make({
  name: "write",
  description: "Write a file.",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
})

/**
 * Each wire's body builder, widened to one shape.
 *
 * The four protocols lower to four different body types, so their `body.from` functions have no
 * common signature — and this file's whole point is to treat them uniformly. The cast is at the
 * boundary, once, where the shapes are known to differ only in what they produce.
 */
type BodyFrom = (request: ReturnType<typeof makeRequest>) => Effect.Effect<Record<string, unknown>>

const WIRES = [
  { id: "openai-chat", route: OpenAIChat.route, from: OpenAIChat.protocol.body.from as unknown as BodyFrom },
  { id: "openai-responses", route: OpenAIResponses.route, from: OpenAIResponses.protocol.body.from as unknown as BodyFrom },
  {
    id: "anthropic-messages",
    route: AnthropicMessages.route,
    from: AnthropicMessages.protocol.body.from as unknown as BodyFrom,
  },
  { id: "gemini", route: Gemini.route, from: Gemini.protocol.body.from as unknown as BodyFrom },
] as const

const body = (wire: (typeof WIRES)[number], toolChannel?: "native" | "prompted") =>
  Effect.runSync(
    wire.from(
      makeRequest({
        model: Model.make({ id: "m", provider: "p", route: wire.route }),
        system: "You are Nova.",
        prompt: "hi",
        tools: [tool],
        ...(toolChannel === undefined ? {} : { toolChannel }),
      } as never),
    ),
  ) as Record<string, unknown>

/** Everything the model will read as instructions, whatever this wire calls it. */
const instructionText = (wire: (typeof WIRES)[number], sent: Record<string, unknown>): string =>
  wire.id === "gemini"
    ? JSON.stringify(sent["systemInstruction"] ?? "")
    : wire.id === "anthropic-messages"
      ? JSON.stringify(sent["system"] ?? "")
      : wire.id === "openai-responses"
        ? JSON.stringify(sent["input"] ?? "")
        : JSON.stringify(sent["messages"] ?? "")

describe("the prompted channel reaches every protocol", () => {
  for (const wire of WIRES) {
    test(`${wire.id}: native still sends the tools array`, () => {
      const sent = body(wire)
      expect(sent["tools"]).toBeDefined()
      expect(instructionText(wire, sent)).not.toContain("# Tools")
    })

    test(`🔴 ${wire.id}: prompted omits the tools AND describes them`, () => {
      const sent = body(wire, "prompted")
      expect(sent["tools"], `${wire.id} still sent a tools array on the prompted channel`).toBeUndefined()
      const instructions = instructionText(wire, sent)
      expect(instructions, `${wire.id} omitted the tools without describing them`).toContain("# Tools")
      expect(instructions).toContain("write")
      // The caller's own system text must survive alongside it.
      expect(instructions).toContain("You are Nova.")
    })
  }

  test("⛔ a protocol added without lowering the channel fails HERE, by name", () => {
    // The list above is hand-written, so this is what stops it going stale. Protocols are found
    // STRUCTURALLY — a module that calls `Protocol.make(` is one — rather than by a name list.
    //
    // ⚠️ That distinction already paid: an exclusion list written by hand in the first draft of this
    // test hid `openai-responses`, which is a real fourth wire with its own tool lowering and was
    // ignoring the channel entirely. A guard whose scope you curate is a guard that agrees with you.
    const dir = path.resolve(import.meta.dir)
    const modules = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".ts") && !name.includes(".test."))
      .filter((name) => fs.readFileSync(path.join(dir, name), "utf8").includes("Protocol.make("))
      .map((name) => name.replace(/\.ts$/, ""))
    expect(modules.sort()).toEqual(WIRES.map((wire) => wire.id).sort())
  })
})
