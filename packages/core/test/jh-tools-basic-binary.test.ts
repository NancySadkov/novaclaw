import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { JhBasicTools } from "../src/jh/tools-basic"
import type { JhProcessRunner } from "../src/jh/process-runner"

const runner: JhProcessRunner.Runner = {
  run: () => Effect.succeed({ exitCode: 0, output: "", timedOut: false }),
}
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function fixture(bytes: Uint8Array, name = "capture.bin") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "novaclaw-jh-binary-"))
  roots.push(root)
  fs.writeFileSync(path.join(root, name), bytes)
  return { root, name, before: fs.readFileSync(path.join(root, name)) }
}

const execute = (cwd: string, tool: string, args: Readonly<Record<string, unknown>>) =>
  Effect.runPromise(JhBasicTools.basicExecutor(runner).run({ tool, args, produces: [], cwd }))

describe("JH text tools refuse binary data without corrupting it", () => {
  test("read_file redirects a packet capture to bounded hexdump inspection", async () => {
    const item = fixture(Uint8Array.from([0xd4, 0xc3, 0xb2, 0xa1, 0, 1, 2, 3]))
    const result = await execute(item.root, "read_file", { path: item.name })

    expect(result.ok).toBe(false)
    expect(result.output).toContain("hexdump -C -n 4096")
    expect(result.output).toContain("file --brief")
    expect(result.output).toContain("never dump an entire large image")
    expect(fs.readFileSync(path.join(item.root, item.name))).toEqual(item.before)
  })

  test.each(["write_file", "append_file", "edit_file", "replace_lines"])(
    "%s refuses an existing binary and explains bounded in-place patching",
    async (tool) => {
      const item = fixture(Uint8Array.from([0, 0xff, 0x10, 0x80]))
      const args =
        tool === "edit_file"
          ? { path: item.name, old_string: "x", new_string: "y" }
          : tool === "replace_lines"
            ? { path: item.name, first_line: 1, last_line: 1, new_content: "y" }
            : { path: item.name, content: "replacement" }
      const result = await execute(item.root, tool, args)

      expect(result.ok).toBe(false)
      expect(result.output).toContain("dd of=")
      expect(result.output).toContain("conv=notrunc")
      expect(fs.readFileSync(path.join(item.root, item.name))).toEqual(item.before)
    },
  )

  test("ordinary UTF-8 text still reads normally", async () => {
    const item = fixture(new TextEncoder().encode("hello\nworld\n"), "notes.txt")
    const result = await execute(item.root, "read_file", { path: item.name })
    expect(result).toMatchObject({ ok: true, output: "hello\nworld\n" })
  })
})
