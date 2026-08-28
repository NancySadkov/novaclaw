import { describe, expect, test } from "bun:test"
import type { ToolDefinition } from "@novaclaw/llm"
import { ReadTool } from "@novaclaw/core/tool/read"
import { VisionCopy } from "@novaclaw/core/session/runner/vision-copy"

/**
 * A TEXT-ONLY model must not be told it can look at pictures (owner, 2026-08-20).
 *
 * The defect this pins: `perceptionSection` is gated on the declared `image` modality, but the
 * `read` tool DESCRIPTION was not — so every model on every turn received *"An image … arrives as a
 * picture you can see"*. The wasted tokens are the smaller half; the model then calls `read` on a
 * PNG and the capability gate refuses the bytes, which is the product describing its own behaviour
 * falsely.
 */

const def = (name: string, description: string): ToolDefinition =>
  ({ name, description, inputSchema: {} }) as ToolDefinition

const READ = def(ReadTool.name, ReadTool.DESCRIPTION)
const OTHER = def("bash", "Run a shell command.")
const TOOLS = [READ, OTHER] as const

const describeRead = (declared: ReadonlyArray<string> | undefined) =>
  VisionCopy.forCapabilities(TOOLS, declared).find((tool) => tool.name === ReadTool.name)!.description

describe("vision copy is spared from text-only models", () => {
  test("a declared text-only model loses the image promise, and only that", () => {
    const stripped = VisionCopy.forCapabilities(TOOLS, ["text"])
    const read = stripped.find((tool) => tool.name === ReadTool.name)!
    expect(read.description).toBe(ReadTool.DESCRIPTION_TEXT_ONLY)
    // The claim that caused the false promise is gone…
    expect(read.description).not.toContain("arrives as a picture you can see")
    expect(read.description).not.toContain("LOOK AT an image")
    expect(read.description.toLowerCase()).not.toContain("png")
    // …while the tool still describes what it actually does for this model.
    expect(read.description).toContain("Read a file")
    expect(read.description).toContain("list a directory")
    expect(read.description).toContain("read-hex")
    // Every other tool is untouched, by identity — not merely by equal text.
    expect(stripped.find((tool) => tool.name === "bash")).toBe(OTHER)
  })

  test("a vision model keeps the wording that was measured to make it look", () => {
    // ⚠️ Negative control. The unhedged image clause is why Holo-3.1 opens an image at all
    // (2026-08-19, `read` called zero times before it). If this ever strips for a vision model the
    // whole capability regresses, and the failure would look like model flakiness.
    expect(VisionCopy.forCapabilities(TOOLS, ["text", "image"])).toBe(TOOLS)
    expect(describeRead(["image"])).toBe(ReadTool.DESCRIPTION)
    expect(describeRead(["text", "Image"])).toBe(ReadTool.DESCRIPTION)
  })

  test("UNKNOWN is not the same as no-vision — the tri-state decides the default", () => {
    // `undefined`/empty mean *nobody told us*, which is what a hand-added local endpoint looks like
    // (`ModelV2.Info.empty` seeds `input: []`). Stripping there would silently disable vision copy
    // for every unmeasured endpoint, so unknown keeps the promise.
    expect(VisionCopy.forCapabilities(TOOLS, undefined)).toBe(TOOLS)
    expect(VisionCopy.forCapabilities(TOOLS, [])).toBe(TOOLS)
  })

  test("the two descriptions differ ONLY by the image sentences", () => {
    // A ratchet on the split itself: if someone edits one variant and not the other, the shared tail
    // stops matching and this fails rather than letting the two drift into different tools.
    const tail = "Prefer this over bash cat/head/tail."
    expect(ReadTool.DESCRIPTION).toContain(tail)
    expect(ReadTool.DESCRIPTION_TEXT_ONLY).toContain(tail)
    const sharedFrom = (text: string) => text.slice(text.indexOf(tail))
    expect(sharedFrom(ReadTool.DESCRIPTION_TEXT_ONLY)).toBe(sharedFrom(ReadTool.DESCRIPTION))
    expect(ReadTool.DESCRIPTION_TEXT_ONLY.length).toBeLessThan(ReadTool.DESCRIPTION.length)
  })

  test("a read tool whose description was already customized is left alone", () => {
    // The transform keys on the EXACT shipped string, so a plugin or a future rewrite that replaced
    // the description is not silently reverted to ours.
    const custom = [def(ReadTool.name, "A totally different read.")] as const
    expect(VisionCopy.forCapabilities(custom, ["text"])).toBe(custom)
  })
})
