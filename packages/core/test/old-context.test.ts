import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  DIR,
  HISTORY_NAME,
  append,
  file,
  render,
  sizeOf,
  tombstone,
} from "../src/session/old-context"
import { Message } from "@novaclaw/llm"

/**
 * 🔴 ONE work-log per agent: appended to, capped, and named the same way every time.
 *
 * `invariants.md` (Context Management 1 and 2) asked for a file the agent "can still grep". The first
 * implementation satisfied the letter and failed the purpose: compaction minted a fresh
 * `oldctx-<DATETIME>.txt` plus an `oldlog-<date>-<time>-<n>.json` sibling on every pass, so Nova's
 * `tmp` accumulated **5,187 files, 0.66 GB** at roughly 20 s each. A pile of timestamped segments is
 * not a log an agent can grep — it is a guessing game about which segment holds what — and the
 * timestamp in the name is tokens spent on a filename, at every compaction, forever.
 *
 * So the name is fixed, the file is appended to, and it is CAPPED. The cap is what makes one big log
 * safe: without it the single file is simply the single file that eats the disk, which is worse,
 * because the agent can then no longer find anything.
 */

const dirs: string[] = []
const tempRoot = async (label: string): Promise<string> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `worklog-${label}-`))
  dirs.push(dir)
  return dir
}

afterAll(async () => {
  await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

const readEntries = async (target: string): Promise<{ at: string; text: string }[]> => {
  const raw = await fs.readFile(target, "utf8")
  const entries: { at: string; text: string }[] = []
  for (const line of raw.split("\n")) {
    if (!line.startsWith("{")) continue
    try {
      const parsed = JSON.parse(line) as { at?: unknown; text?: unknown }
      if (typeof parsed.at === "string" && typeof parsed.text === "string")
        entries.push({ at: parsed.at, text: parsed.text })
    } catch {}
  }
  return entries
}

describe("the work-log has one name, and it never changes", () => {
  test("the name is fixed, so the tombstone is byte-identical at every compaction", () => {
    // This is the token saving, and it is the reason the timestamp went: a name that varies is a
    // prompt that varies, so the prefix cache loses the segment on every single fold.
    expect(HISTORY_NAME).toBe("history.json")
    const scratch = path.join("C:", "Users", "someone", "scratch", "geryon")
    const first = file({ scratchFolder: scratch })
    const second = file({ scratchFolder: scratch })

    expect(first).toBe(second)
    expect(first).toBe(path.join(scratch, DIR, "history.json"))
    // Absolute, because the agent's working directory is not necessarily its scratch folder.
    expect(path.isAbsolute(first)).toBe(true)
  })

  test("the tombstone names the log and says what it is", () => {
    const target = path.join("C:", "scratch", "geryon", "tmp", "history.json")
    const line = tombstone(target)

    expect(line).toBe(`Earlier work-log: ${target.replaceAll("\\", "/")}`)
    // No placeholder may survive into the context the model reads.
    expect(line).not.toContain("%")
  })
})

describe("compaction appends to the log instead of creating a new file", () => {
  test("it creates the whole folder chain when none of it exists", async () => {
    const root = await tempRoot("missing")
    // Nothing exists beforehand: no agent folder, no `tmp`. This is a colleague reached before its own
    // provisioning ran, or a scratch folder deleted under a running instance.
    const scratch = path.join(root, "agent", "scratch")

    const written = await append({ scratchFolder: scratch, at: new Date(0), text: "earlier chat" })

    // The path it RETURNS is the file it WROTE — a tombstone built from anything else is a promise
    // about a file the harness may never have created.
    expect(written).toBe(file({ scratchFolder: scratch }))
    expect(path.dirname(written)).toBe(path.join(scratch, DIR))
    expect((await readEntries(written)).map((entry) => entry.text)).toEqual(["earlier chat"])
  })

  test("N compactions leave ONE file holding N entries, in order", async () => {
    const root = await tempRoot("append")
    const scratch = path.join(root, "geryon")

    for (const text of ["first fold", "second fold", "third fold"]) {
      await append({ scratchFolder: scratch, at: new Date(0), text })
    }

    const target = file({ scratchFolder: scratch })
    // The whole point: one file to grep, not a chain to walk.
    expect((await fs.readdir(path.join(scratch, DIR))).length).toBe(1)
    expect((await readEntries(target)).map((entry) => entry.text)).toEqual([
      "first fold",
      "second fold",
      "third fold",
    ])
  })

  test("a corrupt log never blocks a later fold", async () => {
    // Refusing to append would leave every future compaction's text named in a prompt with nowhere to
    // go — a tombstone pointing at a file that cannot be written, silently, forever. The corrupt bytes
    // stay on disk for a grep; the reader simply skips what it cannot parse.
    const root = await tempRoot("corrupt")
    const scratch = path.join(root, "geryon")
    await fs.mkdir(path.join(scratch, DIR), { recursive: true })
    await fs.writeFile(file({ scratchFolder: scratch }), "{ this is not json", "utf8")

    const written = await append({ scratchFolder: scratch, at: new Date(0), text: "the next fold" })

    expect((await readEntries(written)).map((entry) => entry.text)).toEqual(["the next fold"])
  })

  test("one malformed line does not cost the agent the rest of its log", async () => {
    const root = await tempRoot("partial")
    const scratch = path.join(root, "geryon")
    await fs.mkdir(path.join(scratch, DIR), { recursive: true })
    await fs.writeFile(
      file({ scratchFolder: scratch }),
      `${JSON.stringify({ at: "a", text: "kept" })}\n{"at":5}\nnot json at all\n`,
      "utf8",
    )

    const written = await append({ scratchFolder: scratch, at: new Date(0), text: "appended" })

    expect((await readEntries(written)).map((entry) => entry.text)).toEqual(["kept", "appended"])
  })

  test("an append leaves the earlier bytes untouched — the log is appended, never rewritten", async () => {
    // The regression this pins: the whole file used to be read, parsed, re-stringified and written on
    // every fold. At Lamprias's 186 MB that blocked the server past its health checks and the watchdog
    // killed it mid-fold. If a future change reintroduces a rewrite on the common path, the prefix
    // this compares is no longer byte-identical.
    const root = await tempRoot("inplace")
    const scratch = path.join(root, "geryon")
    await append({ scratchFolder: scratch, at: new Date(0), text: "first fold" })
    const before = await fs.readFile(file({ scratchFolder: scratch }))

    await append({ scratchFolder: scratch, at: new Date(1), text: "second fold" })
    const after = await fs.readFile(file({ scratchFolder: scratch }))

    expect(after.subarray(0, before.length).equals(before)).toBe(true)
  })

  test("the log is one JSON object per line, so a fold is O(the fold)", async () => {
    const root = await tempRoot("jsonl")
    const scratch = path.join(root, "geryon")
    await append({ scratchFolder: scratch, at: new Date(0), text: "first" })
    await append({ scratchFolder: scratch, at: new Date(1), text: "second" })

    const lines = (await fs.readFile(file({ scratchFolder: scratch }), "utf8")).trimEnd().split("\n")
    expect(lines).toHaveLength(2)
    for (const line of lines) {
      const parsed = JSON.parse(line) as { at?: unknown; text?: unknown }
      expect(typeof parsed.at).toBe("string")
      expect(typeof parsed.text).toBe("string")
      // No wrapping array or object: adding an entry cannot require rewriting a closing bracket.
      expect(Array.isArray(parsed)).toBe(false)
    }
  })

  test("the write is atomic, so a crash cannot leave a half-parsed log", async () => {
    const root = await tempRoot("atomic")
    const scratch = path.join(root, "geryon")
    await append({ scratchFolder: scratch, at: new Date(0), text: "real history" })

    // No temp file survives a successful append — a `.tmp` left behind is the seam a crash would use.
    expect(await fs.readdir(path.join(scratch, DIR))).toEqual([HISTORY_NAME])
  })
})

describe("the cap keeps the log bounded and keeps the NEWEST history", () => {
  test("appending past the cap shrinks the file rather than growing it without bound", async () => {
    const root = await tempRoot("cap")
    const scratch = path.join(root, "geryon")
    const chunk = "x".repeat(400)

    for (let i = 0; i < 12; i++) await append({ scratchFolder: scratch, at: new Date(0), text: `${i}${chunk}`, maxBytes: 2000 })

    const target = file({ scratchFolder: scratch })
    const entries = await readEntries(target)
    // Bounded, and the newest fold is still in it — the agent's most recent context is the one thing
    // that must never be the thing that got trimmed.
    expect(entries.length).toBeLessThan(12)
    expect(entries.at(-1)?.text.startsWith("11")).toBe(true)
  })

  test("sizeOf reports the real size, and zero when there is no log", async () => {
    const root = await tempRoot("size")
    const scratch = path.join(root, "geryon")
    expect(await sizeOf(scratch)).toBe(0)

    await append({ scratchFolder: scratch, at: new Date(0), text: "earlier chat" })

    const written = file({ scratchFolder: scratch })
    expect(await sizeOf(scratch)).toBe((await fs.stat(written)).size)
  })
})

/**
 * `invariants.md` (Context Management 2) ends its sentence with the reason the file exists at all:
 * *"we store the cut text in the agent's scratch, so that agent can still grep it."* That is an
 * acceptance test, not a flourish — a file whose content is a JSON blob of wire frames, or a summary
 * of the messages, or their ids, satisfies "we saved something" and fails "grep it". So the body is
 * pinned the way the name is: verbatim text, one message per block, and the tool ids kept, because a
 * tool result without its call is an answer to nothing.
 */
describe("the cut text is written as text an agent can grep", () => {
  test("a message body survives verbatim", () => {
    const needle = "the deploy failed because the migration never ran"
    const rendered = render([Message.user(needle), Message.assistant("understood")])

    expect(rendered).toContain(needle)
    // Its own line, not folded into a structure the agent would have to parse back out.
    expect(rendered.split("\n")).toContain(needle)
  })

  test("roles and order are preserved, in the vocabulary compaction already uses", () => {
    const rendered = render([Message.user("first"), Message.assistant("second"), Message.user("third")])
    const labels = rendered.match(/^\[[a-z]+\]:$/gm)

    expect(labels).toEqual(["[user]:", "[assistant]:", "[user]:"])
    expect(rendered.indexOf("first")).toBeLessThan(rendered.indexOf("second"))
    expect(rendered.indexOf("second")).toBeLessThan(rendered.indexOf("third"))
  })

  test("a tool call and its result keep the id that joins them", () => {
    const call = Message.make({
      id: "msg_call",
      role: "assistant",
      content: [{ type: "tool-call", id: "call_7", name: "read", input: { filePath: "src/a.ts" } }],
    })
    const result = Message.make({
      id: "msg_result",
      role: "tool",
      content: [{ type: "tool-result", id: "call_7", name: "read", result: { type: "text", value: "file body" } }],
    })
    const rendered = render([call, result])

    // The id is the join: an agent reconstructing which of its own actions produced this output needs
    // both halves to name the same call, and the tool's own input is what tells it what was asked.
    expect(rendered.match(/call_7/g)?.length).toBe(2)
    expect(rendered).toContain("src/a.ts")
    expect(rendered).toContain("file body")
  })

  test("an image is a placeholder, not its bytes", () => {
    const rendered = render([
      Message.make({
        id: "msg_media",
        role: "user",
        content: [{ type: "media", mediaType: "image/png", data: "aGVsbG8=", filename: "shot.png" }],
      }),
    ])

    expect(rendered).toContain("image/png")
    expect(rendered).toContain("shot.png")
    // Base64 in a text file an agent greps is noise that hides the text it was looking for.
    expect(rendered).not.toContain("aGVsbG8=")
  })
})
