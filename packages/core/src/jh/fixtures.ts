export * as JhFixtures from "./fixtures"

// jh — the canonical §7 Pi-bignum Step tree, encoded EXACTLY per jh-plan.md Phase 4 (the numbers the
// dataflow tests assert are hand-computed against this shape — do not restructure it). Every later
// phase reuses this as its shared fixture. The task: "100 digits of Pi in C99, compile and verify".

import type { JhStep } from "./step"

const file = (id: string): JhStep.ArtifactRef => ({ id, type: "file" })
const note = (id: string): JhStep.ArtifactRef => ({ id, type: "note" })
const cmd = (id: string): JhStep.ArtifactRef => ({ id, type: "command_output" })

// s2 — bignum primitives (a decomposition producing the four .c files).
const bignum: JhStep.StepDraft = {
  goal: "bignum primitives",
  size: "needs_decomposition",
  success: "the four primitive files exist and compile",
  produces: [file("add.c"), file("sub.c"), file("mul.c"), file("div.c")],
  substeps: [
    { goal: "write add()", size: "atomic", tool: "write_file", args: { path: "add.c", content: "/* add */" }, success: "compiles", produces: [file("add.c")], check: { type: "compile", command: "gcc -c add.c" } },
    { goal: "write subtract()", size: "atomic", tool: "write_file", args: { path: "sub.c", content: "/* sub */" }, success: "compiles", produces: [file("sub.c")], check: { type: "compile", command: "gcc -c sub.c" } },
    { goal: "write multiply_small()", size: "atomic", tool: "write_file", args: { path: "mul.c", content: "/* mul */" }, success: "unit test 999*999", produces: [file("mul.c")], check: { type: "run", command: "gcc mul.c -o t && ./t", expect: "998001" } },
    { goal: "write divide_small()", size: "atomic", tool: "write_file", args: { path: "div.c", content: "/* div */" }, success: "unit test 1000/7", produces: [file("div.c")], check: { type: "run", command: "gcc div.c -o t && ./t", expect: "142" } },
  ],
}

export const piTree: JhStep.StepDraft = {
  goal: "100 digits of Pi in C99, compile and verify",
  size: "needs_decomposition",
  success: "prints and verifies 100 digits of Pi",
  substeps: [
    // s1
    { goal: "pick algorithm", size: "atomic", tool: "note", args: { text: "Machin + fixed-point" }, success: "names a method", produces: [note("algorithm-choice")], check: { type: "artifact_present" } },
    // s2
    bignum,
    // s3
    {
      goal: "write arctan_recip(x)",
      size: "atomic",
      tool: "write_file",
      args: { path: "arctan.c", content: "/* arctan */" },
      success: "unit test: arctan(1)*4 ~= pi",
      consumes: [note("algorithm-choice"), file("add.c"), file("sub.c"), file("mul.c"), file("div.c")],
      produces: [file("arctan.c")],
      check: { type: "run", command: "gcc arctan.c -o t && ./t" },
    },
    // s4
    {
      goal: "combine via Machin",
      size: "atomic",
      tool: "write_file",
      args: { path: "machin.c", content: "/* machin */" },
      success: "compiles; pi ~= 3.14159",
      consumes: [note("algorithm-choice"), file("add.c"), file("sub.c"), file("mul.c"), file("div.c"), file("arctan.c")],
      produces: [file("machin.c")],
      check: { type: "compile", command: "gcc machin.c -o pi" },
    },
    // s5
    {
      goal: "print 100 digits",
      size: "atomic",
      tool: "run",
      args: { command: "./pi" },
      success: "prints 100 chars",
      consumes: [file("machin.c")],
      produces: [cmd("pi-output")],
      check: { type: "run", command: "./pi" },
    },
    // s6
    {
      goal: "verify vs known Pi",
      size: "atomic",
      tool: "run",
      args: { command: "diff pi.out known.out" },
      success: "diff == 0",
      consumes: [cmd("pi-output")],
      produces: [note("verdict")],
      check: { type: "output_equals", command: "diff pi.out known.out", expected: "" },
    },
  ],
}
