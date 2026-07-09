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
})
