import { describe, expect, test } from "bun:test"
import type { ImageAttachmentPart, Prompt } from "@/context/prompt"
import {
  applyHistoryAttachmentBudget,
  createPromptInputHistory,
  MAX_HISTORY_ATTACHMENT_BYTES,
  normalizePromptHistoryEntry,
  prependHistoryEntry,
  type PromptHistoryStoredEntry,
} from "./history"

const attachment = (id: string, bytes: number): ImageAttachmentPart => ({
  type: "image",
  id,
  filename: `${id}.png`,
  sourcePath: `/tmp/${id}.png`,
  mime: "image/png",
  dataUrl: `data:image/png;base64,${"A".repeat(bytes)}`,
})

const composed = (value: string, ...parts: ImageAttachmentPart[]): Prompt => [
  { type: "text", content: value, start: 0, end: value.length },
  ...parts,
]

const images = (entry: PromptHistoryStoredEntry) =>
  normalizePromptHistoryEntry(entry)
    .prompt.filter((part) => part.type === "image")
    .map((part) => part.id)

const promptText = (entry: PromptHistoryStoredEntry) =>
  normalizePromptHistoryEntry(entry)
    .prompt.map((part) => ("content" in part ? part.content : ""))
    .join("")

describe("prompt history keeps attachment data inside a fixed budget", () => {
  test("an attachment larger than the whole budget never reaches the store, and the entry stays usable", () => {
    const history = createPromptInputHistory()
    const huge = attachment("photo", MAX_HISTORY_ATTACHMENT_BYTES + 1)

    history.add(composed("look at this", huge), "normal", [])

    // Read the store back — assert what was actually written, not what we handed it.
    const stored = history.entries("normal")
    expect(stored).toHaveLength(1)
    expect(images(stored[0])).toEqual([])
    expect(promptText(stored[0])).toBe("look at this")
    expect(JSON.stringify(stored)).not.toContain("AAAA")
  })

  test("the oversized attachment is dropped from HISTORY only — the composed prompt is untouched", () => {
    const huge = attachment("photo", MAX_HISTORY_ATTACHMENT_BYTES + 1)
    const live = composed("send this", huge)

    prependHistoryEntry([], live)

    expect(live).toHaveLength(2)
    expect(live[1]).toBe(huge)
    expect(huge.dataUrl.length).toBe(MAX_HISTORY_ATTACHMENT_BYTES + 1 + "data:image/png;base64,".length)
  })

  test("the budget is a TOTAL across entries: the newest keep their attachments, older ones shed theirs", () => {
    const half = Math.floor(MAX_HISTORY_ATTACHMENT_BYTES / 2) - 64
    const history = createPromptInputHistory()

    history.add(composed("one", attachment("a", half)), "normal", [])
    history.add(composed("two", attachment("b", half)), "normal", [])
    expect(history.entries("normal").map(images)).toEqual([["b"], ["a"]])

    history.add(composed("three", attachment("c", half)), "normal", [])
    const stored = history.entries("normal")
    expect(stored.map(promptText)).toEqual(["three", "two", "one"])
    expect(stored.map(images)).toEqual([["c"], ["b"], []])
  })

  test("under the budget nothing is dropped and the history round-trips unchanged", () => {
    const history = createPromptInputHistory()
    const small = attachment("thumb", 1024)

    history.add(composed("with a thumbnail", small), "normal", [])
    history.add(composed("plain text only"), "normal", [])

    const stored = history.entries("normal")
    expect(stored.map(promptText)).toEqual(["plain text only", "with a thumbnail"])
    expect(stored.map(images)).toEqual([[], ["thumb"]])
    expect(normalizePromptHistoryEntry(stored[1]).prompt[1]).toEqual(small)
  })

  test("a list already inside the budget is returned by identity, so an unchanged store is not rewritten", () => {
    const entries: PromptHistoryStoredEntry[] = [
      { prompt: composed("a", attachment("x", 512)), comments: [] },
      { prompt: composed("b"), comments: [] },
    ]
    expect(applyHistoryAttachmentBudget(entries)).toBe(entries)
  })

  test("a legacy history written before the budget existed is repaired on the next write", () => {
    const legacy: PromptHistoryStoredEntry[] = [composed("old", attachment("bloat", MAX_HISTORY_ATTACHMENT_BYTES * 2))]

    const next = prependHistoryEntry(legacy, composed("new"))

    expect(next).toHaveLength(2)
    expect(images(next[1])).toEqual([])
    expect(promptText(next[1])).toBe("old")
  })
})
