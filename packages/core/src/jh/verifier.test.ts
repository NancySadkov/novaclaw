import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { Presence } from "../presence"
import type { JhStep } from "./step"
import { JhProcessRunner } from "./process-runner"
import { JhVerifier } from "./verifier"

const rr = (over: Partial<JhProcessRunner.RunResult> = {}): JhProcessRunner.RunResult => ({
  exitCode: 0,
  output: "",
  timedOut: false,
  ...over,
})
const fake = (result: JhProcessRunner.RunResult): JhProcessRunner.Runner => ({ run: () => Effect.succeed(result) })

const doVerify = (
  check: JhStep.Check,
  opts: {
    runner?: JhProcessRunner.Runner
    fileExists?: (p: string) => boolean
    filePresence?: (p: string) => Presence.Answer
    produced?: JhVerifier.Produced
    defaultTimeoutMs?: number
  } = {},
) =>
  Effect.runPromise(
    JhVerifier.verify({
      check,
      cwd: process.cwd(),
      runner: opts.runner ?? fake(rr()),
      fileExists: opts.fileExists ?? (() => false),
      ...(opts.filePresence === undefined ? {} : { filePresence: opts.filePresence }),
      produced: opts.produced ?? "missing",
      defaultTimeoutMs: opts.defaultTimeoutMs,
    }),
  )

describe("JhVerifier.verify (fake runner)", () => {
  test("compile pass / fail (fail detail = output tail)", async () => {
    expect(await doVerify({ type: "compile", command: "x" }, { runner: fake(rr({ exitCode: 0 })) })).toEqual({
      ok: true,
      detail: "",
    })
    expect(
      await doVerify({ type: "compile", command: "x" }, { runner: fake(rr({ exitCode: 1, output: "boom" })) }),
    ).toEqual({ ok: false, detail: "boom" })
  })

  test("run pass / fail", async () => {
    expect(
      (await doVerify({ type: "run", command: "x" }, { runner: fake(rr({ exitCode: 0, output: "ok" })) })).ok,
    ).toBe(true)
    expect(
      (await doVerify({ type: "run", command: "x" }, { runner: fake(rr({ exitCode: 2, output: "err" })) })).ok,
    ).toBe(false)
  })

  test("run with expect: substring present passes, absent fails", async () => {
    expect(
      (
        await doVerify(
          { type: "run", command: "x", expect: "OK" },
          { runner: fake(rr({ exitCode: 0, output: "all OK here" })) },
        )
      ).ok,
    ).toBe(true)
    const miss = await doVerify(
      { type: "run", command: "x", expect: "OK" },
      { runner: fake(rr({ exitCode: 0, output: "nope" })) },
    )
    expect(miss.ok).toBe(false)
    expect(miss.detail).toContain("expected output to contain")
  })

  test("output_equals: CRLF-normalized/trimmed equality passes; mismatch reports expected/got", async () => {
    const pass = await doVerify(
      { type: "output_equals", command: "x", expected: "line1\nline2" },
      { runner: fake(rr({ output: "line1\r\nline2\r\n" })) },
    )
    expect(pass.ok).toBe(true)
    const fail = await doVerify(
      { type: "output_equals", command: "x", expected: "a" },
      { runner: fake(rr({ output: "b" })) },
    )
    expect(fail.ok).toBe(false)
    expect(fail.detail).toBe("expected a, got b")
  })

  test("file_exists pass / fail via the injected probe", async () => {
    expect((await doVerify({ type: "file_exists", path: "foo" }, { fileExists: (p) => p === "foo" })).ok).toBe(true)
    expect(await doVerify({ type: "file_exists", path: "foo" }, { fileExists: () => false })).toEqual({
      ok: false,
      detail: "file not found: foo",
    })
  })

  // ─── a check that could not be PERFORMED is not a check the subject failed ────────────────────
  //
  // 🔴 Audited 2026-08-19. `file_exists` was built on `session/runner/strict.ts`'s `fs.existsSync`,
  // which answers `false` for `EACCES`, `EPERM`, `ELOOP` and `EIO` exactly as it does for `ENOENT`. So
  // a locked path put the sentence **"file not found: <path>"** into the transcript the model reads
  // back as established fact, and the gate — whose entire job is to be the objective check — was the
  // thing fabricating the observation.
  describe("file_exists — three answers, because a failed probe is not an absent file", () => {
    test("an UNREADABLE path never says “file not found”, and is marked inconclusive", async () => {
      const result = await doVerify({ type: "file_exists", path: "locked.txt" }, { filePresence: () => "unreadable" })
      expect(result.ok).toBe(false)
      expect(result.inconclusive).toBe(true)
      // The assertion the whole change is about: no claim about the user's disk.
      for (const forbidden of ["file not found", "missing", "does not exist"])
        expect({ forbidden, detail: result.detail.includes(forbidden) }).toEqual({ forbidden, detail: false })
      expect(result.detail).toContain("could not check locked.txt")
      expect(result.detail).toContain("NOTHING about whether the file is there")
    })

    test("a CONFIRMED absence still fails the step, and still says so plainly", async () => {
      // The one-directional guarantee: this can only ever stop us asserting a failure we did not
      // witness. A real miss is unchanged, so a transport-shaped excuse can never hide a real one.
      const result = await doVerify({ type: "file_exists", path: "gone.txt" }, { filePresence: () => "absent" })
      expect(result).toEqual({ ok: false, detail: "file not found: gone.txt" })
    })

    test("`present` passes, and the two-answer probe still works for callers that only have one", async () => {
      expect((await doVerify({ type: "file_exists", path: "a" }, { filePresence: () => "present" })).ok).toBe(true)
      // No `filePresence` supplied: every in-memory suite in this package keeps its boolean probe.
      expect((await doVerify({ type: "file_exists", path: "a" }, { fileExists: () => true })).ok).toBe(true)
    })

    test("⭐ `filePresence` WINS over `fileExists` — otherwise the honest probe would be decorative", async () => {
      // The trap this pins: threading a new field in but leaving the old one in charge. `strict.ts`
      // supplies both (the boolean is still on the engine's required contract), so if precedence went
      // the other way the fix would typecheck, ship, and change nothing.
      const result = await doVerify(
        { type: "file_exists", path: "locked.txt" },
        { fileExists: () => false, filePresence: () => "unreadable" },
      )
      expect(result.inconclusive).toBe(true)
    })
  })

  test("artifact_present pass / fail via the flag", async () => {
    expect((await doVerify({ type: "artifact_present" }, { produced: "present" })).ok).toBe(true)
    expect((await doVerify({ type: "artifact_present" }, { produced: "missing" })).ok).toBe(false)
  })

  test("artifact_present over ZERO declared produces is REFUSED, never passed", async () => {
    // The gate's contract is "every declared produce was committed with non-empty content"; over zero
    // declarations that is vacuously satisfied, and a vacuous check is worse than no check because the
    // step reports VERIFIED. Refused as unverifiable: `ok:false` (the gate may not certify what it could
    // not check) + `inconclusive` (the fault is our instrument, not the step's work).
    const res = await doVerify({ type: "artifact_present" }, { produced: "none_declared" })
    expect(res.ok).toBe(false)
    expect(res.inconclusive).toBe(true)
    expect(res.detail).toContain("NOTHING to check")
    // It must not assert a failure it never witnessed — the `file_exists` audit's rule, same gate.
    for (const forbidden of ["missing or empty", "not found"])
      expect({ forbidden, said: res.detail.includes(forbidden) }).toEqual({ forbidden, said: false })
  })

  test("timeout is classified, actionable (C9), and honors the caller's default", async () => {
    const res = await doVerify(
      { type: "compile", command: "x" },
      { runner: fake(rr({ timedOut: true, exitCode: undefined })) },
    )
    expect(res.ok).toBe(false)
    expect(res.detail).toContain("timed out after 60000ms")
    expect(res.detail).toContain("INFINITE LOOP") // C9: never a bare "timed out" — that manufactures an opaque rut
    const short = await doVerify(
      { type: "compile", command: "x" },
      { runner: fake(rr({ timedOut: true, exitCode: undefined })), defaultTimeoutMs: 15_000 },
    )
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
