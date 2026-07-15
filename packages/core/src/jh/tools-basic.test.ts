import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { JhStep } from "./step"
import { JhBasicTools } from "./tools-basic"
import { JhProcessRunner } from "./process-runner"

const exec = JhBasicTools.basicExecutor(JhProcessRunner.shellRunner())
const ref = (id: string, type: JhStep.ArtifactType): JhStep.ArtifactRef => ({ id, type })
const runTool = (tool: string, args: Record<string, unknown>, produces: JhStep.ArtifactRef[], cwd: string) => Effect.runPromise(exec.run({ tool, args, produces, cwd }))
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "jh-tools-"))

describe("JhBasicTools.basicExecutor", () => {
  test("write_file writes under cwd (mkdir parents) and sets the first file produce", async () => {
    const cwd = tmp()
    const obs = await runTool("write_file", { path: "sub/dir/a.c", content: "int x;" }, [ref("a", "file")], cwd)
    expect(obs.ok).toBe(true)
    expect(fs.readFileSync(path.join(cwd, "sub", "dir", "a.c"), "utf8")).toBe("int x;")
    expect(obs.artifacts.get("a")).toBe("int x;")
    expect(obs.output).toContain("wrote")
  })

  test("write_file refuses absolute paths and `..` escapes", async () => {
    const cwd = tmp()
    expect((await runTool("write_file", { path: path.join(cwd, "abs.c"), content: "x" }, [], cwd)).ok).toBe(false)
    expect((await runTool("write_file", { path: "../escape.c", content: "x" }, [], cwd)).ok).toBe(false)
  })

  test("append_file creates a missing file, then grows it with blank-line glue (improve17 beat-runs)", async () => {
    const cwd = tmp()
    const first = await runTool("append_file", { path: "ch1.md", content: "First beat-run." }, [ref("a", "file")], cwd)
    expect(first.ok).toBe(true)
    expect(fs.readFileSync(path.join(cwd, "ch1.md"), "utf8")).toBe("First beat-run.")
    const second = await runTool("append_file", { path: "ch1.md", content: "Second beat-run." }, [ref("a", "file")], cwd)
    expect(second.ok).toBe(true)
    // no trailing newline on the existing text → a full blank-line paragraph separator
    expect(fs.readFileSync(path.join(cwd, "ch1.md"), "utf8")).toBe("First beat-run.\n\nSecond beat-run.")
    // the file produce carries the WHOLE updated content (the oracle sees the full state)
    expect(second.artifacts.get("a")).toBe("First beat-run.\n\nSecond beat-run.")
    expect(second.output).toContain("appended")
  })

  test("append_file glue: a single trailing newline gains one more; a double stays as-is", async () => {
    const cwd = tmp()
    fs.writeFileSync(path.join(cwd, "one.md"), "para\n")
    await runTool("append_file", { path: "one.md", content: "next" }, [], cwd)
    expect(fs.readFileSync(path.join(cwd, "one.md"), "utf8")).toBe("para\n\nnext")
    fs.writeFileSync(path.join(cwd, "two.md"), "para\n\n")
    await runTool("append_file", { path: "two.md", content: "next" }, [], cwd)
    expect(fs.readFileSync(path.join(cwd, "two.md"), "utf8")).toBe("para\n\nnext")
  })

  test("append_file refuses unsafe paths, bad args, and empty content", async () => {
    const cwd = tmp()
    expect((await runTool("append_file", { path: "../escape.md", content: "x" }, [], cwd)).ok).toBe(false)
    expect((await runTool("append_file", { path: "a.md" }, [], cwd)).ok).toBe(false)
    const empty = await runTool("append_file", { path: "a.md", content: "" }, [], cwd)
    expect(empty.ok).toBe(false)
    expect(empty.output).toContain("empty")
  })

  test("read_file reads under cwd and sets the first produce", async () => {
    const cwd = tmp()
    fs.writeFileSync(path.join(cwd, "r.txt"), "hello")
    const obs = await runTool("read_file", { path: "r.txt" }, [ref("r", "text")], cwd)
    expect(obs.ok).toBe(true)
    expect(obs.output).toBe("hello")
    expect(obs.artifacts.get("r")).toBe("hello")
  })

  test("run maps exit code and sets a command_output produce", async () => {
    const cwd = tmp()
    const ok = await runTool("run", { command: "echo hi" }, [ref("o", "command_output")], cwd)
    expect(ok.ok).toBe(true)
    expect(ok.artifacts.get("o")).toContain("hi")
    expect((await runTool("run", { command: "exit 3" }, [], cwd)).ok).toBe(false)
  })

  test("run with a non-zero exit + no output → a CRASH message naming the exit code (not an empty error)", async () => {
    const r = await runTool("run", { command: "exit 42" }, [], tmp())
    expect(r.ok).toBe(false)
    expect(r.output).toContain("42") // the exit code is surfaced
    expect(r.output.toLowerCase()).toContain("crash") // + the source-bug directive, so the model doesn't just re-run
  })

  test("edit_file replaces ONE unique occurrence and sets the first file produce to the NEW content", async () => {
    const cwd = tmp()
    fs.writeFileSync(path.join(cwd, "p.c"), "int main(){ return 0; }")
    const obs = await runTool("edit_file", { path: "p.c", old_string: "return 0;", new_string: "return 42;" }, [ref("f", "file")], cwd)
    expect(obs.ok).toBe(true)
    expect(fs.readFileSync(path.join(cwd, "p.c"), "utf8")).toBe("int main(){ return 42; }")
    expect(obs.artifacts.get("f")).toBe("int main(){ return 42; }") // produce = full NEW content
    expect(obs.output).toContain("edited p.c")
  })

  test("edit_file: missing file, no match, and >1 match each fail helpfully", async () => {
    const cwd = tmp()
    expect((await runTool("edit_file", { path: "nope.c", old_string: "a", new_string: "b" }, [], cwd)).output).toContain("file not found")
    fs.writeFileSync(path.join(cwd, "d.c"), "x = 1; x = 1;")
    expect((await runTool("edit_file", { path: "d.c", old_string: "zzz", new_string: "b" }, [], cwd)).output).toContain("not found in")
    const dup = await runTool("edit_file", { path: "d.c", old_string: "x = 1;", new_string: "y = 2;" }, [], cwd)
    expect(dup.ok).toBe(false)
    expect(dup.output).toContain("occurs 2 times")
  })

  test("edit_file refuses unsafe paths and bad args", async () => {
    const cwd = tmp()
    expect((await runTool("edit_file", { path: "../e.c", old_string: "a", new_string: "b" }, [], cwd)).ok).toBe(false)
    expect((await runTool("edit_file", { path: "p.c", old_string: 1, new_string: "b" }, [], cwd)).ok).toBe(false)
  })

  // improve3 P4 — near-miss tiers (C7): heal CRLF / trailing-space / indent drift in a full-line/multi-line quote.
  test("edit_file near-miss: CRLF drift heals (tier 1)", async () => {
    const cwd = tmp()
    fs.writeFileSync(path.join(cwd, "a.c"), "int a;\r\nint b;\r\nint c;\r\n") // CRLF file
    const obs = await runTool("edit_file", { path: "a.c", old_string: "int a;\nint b;", new_string: "int a;\nint B;" }, [], cwd) // LF quote spanning 2 lines
    expect(obs.ok).toBe(true)
    expect(obs.output).toContain("normalization")
    expect(fs.readFileSync(path.join(cwd, "a.c"), "utf8")).toContain("int B;")
  })

  test("edit_file near-miss: trailing-space drift heals (tier 1)", async () => {
    const cwd = tmp()
    fs.writeFileSync(path.join(cwd, "a.c"), "alpha   \nbeta\n") // trailing spaces on line 1
    const obs = await runTool("edit_file", { path: "a.c", old_string: "alpha\nbeta", new_string: "ALPHA\nbeta" }, [], cwd)
    expect(obs.ok).toBe(true)
    expect(fs.readFileSync(path.join(cwd, "a.c"), "utf8")).toContain("ALPHA")
  })

  test("edit_file near-miss: leading-indent drift heals (tier 2)", async () => {
    const cwd = tmp()
    fs.writeFileSync(path.join(cwd, "a.c"), "void f(){\n    return 0;\n    return 1;\n}\n") // 4-space indented block
    const obs = await runTool("edit_file", { path: "a.c", old_string: "return 0;\nreturn 1;", new_string: "return 2;\nreturn 3;" }, [], cwd) // no indent in the quote
    expect(obs.ok).toBe(true)
    expect(obs.output).toContain("indentation")
    expect(fs.readFileSync(path.join(cwd, "a.c"), "utf8")).toContain("return 2;")
  })

  test("edit_file: a unique EXACT substring uses tier 0 (no normalization note)", async () => {
    const cwd = tmp()
    fs.writeFileSync(path.join(cwd, "a.c"), "void f(){\n  return 0;\n}\n")
    const obs = await runTool("edit_file", { path: "a.c", old_string: "return 0;", new_string: "return 9;" }, [], cwd)
    expect(obs.ok).toBe(true)
    expect(obs.output).not.toContain("normalization") // exact tier, not a near-miss
    expect(fs.readFileSync(path.join(cwd, "a.c"), "utf8")).toContain("return 9;")
  })

  test("edit_file: multiple normalized matches still fail (uniqueness enforced at the tier)", async () => {
    const cwd = tmp()
    fs.writeFileSync(path.join(cwd, "a.c"), "  foo\n    foo\n") // both lines are `foo` after indent-flex
    const obs = await runTool("edit_file", { path: "a.c", old_string: "foo", new_string: "bar" }, [], cwd)
    expect(obs.ok).toBe(false)
    expect(obs.output).toContain("occurs")
  })

  test("edit_file: total miss names the nearest line", async () => {
    const cwd = tmp()
    fs.writeFileSync(path.join(cwd, "a.c"), "int compute_sum(int n) {\n  return n;\n}\n")
    const obs = await runTool("edit_file", { path: "a.c", old_string: "int compute_total(int n) {", new_string: "x" }, [], cwd)
    expect(obs.ok).toBe(false)
    expect(obs.output).toContain("nearest line")
    expect(obs.output).toContain("compute_sum")
  })

  test("note passes text through to a note produce", async () => {
    const obs = await runTool("note", { text: "the choice" }, [ref("n", "note")], tmp())
    expect(obs.ok).toBe(true)
    expect(obs.artifacts.get("n")).toBe("the choice")
  })

  test("unknown tool → ok:false, lists available", async () => {
    const obs = await runTool("frobnicate", {}, [], tmp())
    expect(obs.ok).toBe(false)
    expect(obs.output).toContain("unknown tool")
  })

  test("bad args → ok:false", async () => {
    expect((await runTool("write_file", { path: 123, content: "x" }, [], tmp())).ok).toBe(false)
    expect((await runTool("run", {}, [], tmp())).ok).toBe(false)
  })

  // improve5 P1d — near-miss tier 3 (whitespace-collapsed): a re-typed line whose INTERNAL spacing drifted.
  test("edit_file near-miss: whitespace-collapsed drift heals (tier 3)", async () => {
    const cwd = tmp()
    fs.writeFileSync(path.join(cwd, "a.c"), "int  x   =    1;") // odd internal spacing on disk
    const obs = await runTool("edit_file", { path: "a.c", old_string: "int x = 1;", new_string: "int x = 2;" }, [], cwd) // clean quote
    expect(obs.ok).toBe(true)
    expect(obs.output).toContain("whitespace-collapsed")
    expect(fs.readFileSync(path.join(cwd, "a.c"), "utf8")).toBe("int x = 2;")
  })

  test("edit_file near-miss tier 3 still refuses a MULTI-match (uniqueness enforced)", async () => {
    const cwd = tmp()
    // both lines have ODD internal spacing (no exact/tier-1/2 match for the clean quote), but collapse to the same
    fs.writeFileSync(path.join(cwd, "a.c"), "int  a;\nint   a;")
    const obs = await runTool("edit_file", { path: "a.c", old_string: "int a;", new_string: "int b;" }, [], cwd)
    expect(obs.ok).toBe(false)
    expect(obs.output).toMatch(/occurs 2 times/) // tier-3 collapse found 2 → refuse, never a silent wrong edit
    expect(fs.readFileSync(path.join(cwd, "a.c"), "utf8")).toBe("int  a;\nint   a;") // unchanged
  })

  // improve5 P1c — replace_lines: coordinate-addressed editing.
  test("replace_lines replaces an inclusive 1-based range + echoes the removed text", async () => {
    const cwd = tmp()
    fs.writeFileSync(path.join(cwd, "p.c"), "l1\nl2\nl3\nl4\nl5")
    const obs = await runTool("replace_lines", { path: "p.c", first_line: 2, last_line: 3, new_content: "X\nY\nZ" }, [ref("f", "file")], cwd)
    expect(obs.ok).toBe(true)
    expect(fs.readFileSync(path.join(cwd, "p.c"), "utf8")).toBe("l1\nX\nY\nZ\nl4\nl5")
    expect(obs.output).toContain("replaced lines 2-3")
    expect(obs.output).toContain("l2\\nl3") // echoes what was removed (JSON-escaped)
    expect(obs.artifacts.get("f")).toBe("l1\nX\nY\nZ\nl4\nl5")
  })

  test("replace_lines a single line (first==last)", async () => {
    const cwd = tmp()
    fs.writeFileSync(path.join(cwd, "p.c"), "a\nb\nc")
    const obs = await runTool("replace_lines", { path: "p.c", first_line: 2, last_line: 2, new_content: "B" }, [], cwd)
    expect(obs.ok).toBe(true)
    expect(fs.readFileSync(path.join(cwd, "p.c"), "utf8")).toBe("a\nB\nc")
  })

  test("replace_lines out-of-range names the file's actual line count and does NOT write", async () => {
    const cwd = tmp()
    fs.writeFileSync(path.join(cwd, "p.c"), "a\nb\nc") // 3 lines
    const obs = await runTool("replace_lines", { path: "p.c", first_line: 3, last_line: 9, new_content: "X" }, [], cwd)
    expect(obs.ok).toBe(false)
    expect(obs.output).toContain("has 3 lines")
    expect(fs.readFileSync(path.join(cwd, "p.c"), "utf8")).toBe("a\nb\nc") // unchanged
  })

  test("replace_lines rejects first_line > last_line and non-integer / missing args", async () => {
    const cwd = tmp()
    fs.writeFileSync(path.join(cwd, "p.c"), "a\nb\nc")
    expect((await runTool("replace_lines", { path: "p.c", first_line: 3, last_line: 1, new_content: "X" }, [], cwd)).ok).toBe(false)
    expect((await runTool("replace_lines", { path: "p.c", first_line: 1.5, last_line: 2, new_content: "X" }, [], cwd)).ok).toBe(false)
    expect((await runTool("replace_lines", { path: "p.c", first_line: 1, new_content: "X" }, [], cwd)).ok).toBe(false)
  })

  test("replace_lines refuses unsafe paths + a missing file", async () => {
    const cwd = tmp()
    expect((await runTool("replace_lines", { path: "../x.c", first_line: 1, last_line: 1, new_content: "X" }, [], cwd)).ok).toBe(false)
    expect((await runTool("replace_lines", { path: "ghost.c", first_line: 1, last_line: 1, new_content: "X" }, [], cwd)).output).toContain("file not found")
  })

  test("replace_lines is in TOOL_NAMES (offered by default)", () => {
    expect(JhBasicTools.TOOL_NAMES).toContain("replace_lines")
  })
})
