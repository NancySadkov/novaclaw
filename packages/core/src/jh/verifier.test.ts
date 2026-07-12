import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { JhStep } from "./step"
import { JhProcessRunner } from "./process-runner"
import { JhVerifier } from "./verifier"

const rr = (over: Partial<JhProcessRunner.RunResult> = {}): JhProcessRunner.RunResult => ({ exitCode: 0, output: "", timedOut: false, ...over })
const fake = (result: JhProcessRunner.RunResult): JhProcessRunner.Runner => ({ run: () => Effect.succeed(result) })

const doVerify = (
  check: JhStep.Check,
  opts: { runner?: JhProcessRunner.Runner; fileExists?: (p: string) => boolean; producedPresent?: boolean; defaultTimeoutMs?: number } = {},
) =>
  Effect.runPromise(
    JhVerifier.verify({
      check,
      cwd: process.cwd(),
      runner: opts.runner ?? fake(rr()),
      fileExists: opts.fileExists ?? (() => false),
      producedPresent: opts.producedPresent ?? false,
      defaultTimeoutMs: opts.defaultTimeoutMs,
    }),
  )

describe("JhVerifier.verify (fake runner)", () => {
  test("compile pass / fail (fail detail = output tail)", async () => {
    expect(await doVerify({ type: "compile", command: "x" }, { runner: fake(rr({ exitCode: 0 })) })).toEqual({ ok: true, detail: "" })
    expect(await doVerify({ type: "compile", command: "x" }, { runner: fake(rr({ exitCode: 1, output: "boom" })) })).toEqual({ ok: false, detail: "boom" })
  })

  test("run pass / fail", async () => {
    expect((await doVerify({ type: "run", command: "x" }, { runner: fake(rr({ exitCode: 0, output: "ok" })) })).ok).toBe(true)
    expect((await doVerify({ type: "run", command: "x" }, { runner: fake(rr({ exitCode: 2, output: "err" })) })).ok).toBe(false)
  })

  test("run with expect: substring present passes, absent fails", async () => {
    expect((await doVerify({ type: "run", command: "x", expect: "OK" }, { runner: fake(rr({ exitCode: 0, output: "all OK here" })) })).ok).toBe(true)
    const miss = await doVerify({ type: "run", command: "x", expect: "OK" }, { runner: fake(rr({ exitCode: 0, output: "nope" })) })
    expect(miss.ok).toBe(false)
    expect(miss.detail).toContain("expected output to contain")
  })

  test("output_equals: CRLF-normalized/trimmed equality passes; mismatch reports expected/got", async () => {
    const pass = await doVerify({ type: "output_equals", command: "x", expected: "line1\nline2" }, { runner: fake(rr({ output: "line1\r\nline2\r\n" })) })
    expect(pass.ok).toBe(true)
    const fail = await doVerify({ type: "output_equals", command: "x", expected: "a" }, { runner: fake(rr({ output: "b" })) })
    expect(fail.ok).toBe(false)
    expect(fail.detail).toBe("expected a, got b")
  })

  test("file_exists pass / fail via the injected probe", async () => {
    expect((await doVerify({ type: "file_exists", path: "foo" }, { fileExists: (p) => p === "foo" })).ok).toBe(true)
    expect(await doVerify({ type: "file_exists", path: "foo" }, { fileExists: () => false })).toEqual({ ok: false, detail: "file not found: foo" })
  })

  test("artifact_present pass / fail via the flag", async () => {
    expect((await doVerify({ type: "artifact_present" }, { producedPresent: true })).ok).toBe(true)
    expect((await doVerify({ type: "artifact_present" }, { producedPresent: false })).ok).toBe(false)
  })

  test("timeout is classified, actionable (C9), and honors the caller's default", async () => {
    const res = await doVerify({ type: "compile", command: "x" }, { runner: fake(rr({ timedOut: true, exitCode: undefined })) })
    expect(res.ok).toBe(false)
    expect(res.detail).toContain("timed out after 60000ms")
    expect(res.detail).toContain("INFINITE LOOP") // C9: never a bare "timed out" — that manufactures an opaque rut
    const short = await doVerify({ type: "compile", command: "x" }, { runner: fake(rr({ timedOut: true, exitCode: undefined })), defaultTimeoutMs: 15_000 })
    expect(short.detail).toContain("timed out after 15000ms")
  })

  test("fail detail is the TAIL of long output (≤ 2000 chars)", async () => {
    const long = "H".repeat(3000) + "TAIL_MARKER"
    const res = await doVerify({ type: "compile", command: "x" }, { runner: fake(rr({ exitCode: 1, output: long })) })
    expect(res.detail.length).toBe(2000)
    expect(res.detail.endsWith("TAIL_MARKER")).toBe(true)
  })
})

describe("JhVerifier.verify (real shell runner)", () => {
  const runner = JhProcessRunner.shellRunner()

  test("echo hi → output_equals 'hi' passes", async () => {
    expect((await doVerify({ type: "output_equals", command: "echo hi", expected: "hi" }, { runner })).ok).toBe(true)
  })

  test("exit 1 → compile fails", async () => {
    expect((await doVerify({ type: "compile", command: "exit 1" }, { runner })).ok).toBe(false)
  })

  test("unknown binary → fails, does not throw", async () => {
    const res = await doVerify({ type: "compile", command: "definitely-not-a-binary-xyz" }, { runner })
    expect(res.ok).toBe(false)
  })
})
