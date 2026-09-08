import { expect, test } from "bun:test"
import { JhController } from "./controller"
import { JhStaleness } from "./staleness"
import { JhRegression } from "./regression"

test("JSON checkpoints preserve build order, failures, spent budgets and non-finite score sentinels", () => {
  const tracker = JhStaleness.tracker()
  const files = [{ name: "math.c", content: "good" }]
  const object = [...files, { name: "math.o", content: "object" }]
  const binary = [...object, { name: "test.exe", content: "program" }]
  tracker.recordAction({
    tool: "run",
    ok: true,
    command: "cc -c math.c -o math.o",
    before: tracker.snap(files),
    after: tracker.snap(object),
  })
  tracker.recordAction({
    tool: "run",
    ok: true,
    command: "cc math.o -o test.exe",
    before: tracker.snap(object),
    after: tracker.snap(binary),
  })
  const registry = JhRegression.registry()
  registry.register({
    command: "./test.exe",
    depsDigest: tracker.sourceDigestNow(tracker.snap(binary)),
    expect: "PASS",
  })
  registry.recordResult("./test.exe", false, "failed-source")
  registry.markUnsanitized("./test.exe")
  const controller = JhController.create()
  controller.staleness = tracker.snapshot() as typeof controller.staleness
  controller.regression = registry.all() as typeof controller.regression
  controller.gateChecks = 3
  controller.elapsedMs = 700
  controller.firedBudget.add(0.5)
  controller.lastFixBest.set("root", -Infinity)
  controller.leaves.set("leaf", {
    budget: 1,
    errorCounts: new Map([["compile", 3]]),
    lastFailDigest: "digest",
    lastFailDetail: "broken",
  })
  const wire = JSON.parse(JSON.stringify(JhController.encode(controller)))
  const restored = JhController.decode(wire)
  expect(restored).toEqual(controller)
  expect(restored.bestScore).toBe(-Infinity)
  const resumedTracker = JhStaleness.tracker(restored.staleness)
  const edited = [{ name: "math.c", content: "broken" }, ...binary.slice(1)]
  expect(resumedTracker.staleChainFor("./test.exe", resumedTracker.snap(edited))).toEqual([
    { file: "math.o", rebuild: "cc -c math.c -o math.o" },
    { file: "test.exe", rebuild: "cc math.o -o test.exe" },
  ])
  expect(JhRegression.registry(restored.regression).staleTests(() => "new-source")).toEqual(registry.all())
  // The snapshot is detached from the next attempt's mutable collections.
  controller.leaves.get("leaf")!.errorCounts.set("compile", 4)
  expect(restored.leaves.get("leaf")!.errorCounts.get("compile")).toBe(3)
})

test("incomplete, unsupported and malformed controller checkpoints are refused", () => {
  const wire = JhController.encode(JhController.create()) as Record<string, unknown>
  for (const invalid of [
    undefined,
    {},
    { ...wire, version: 0 },
    { ...wire, gateChecks: -1 },
    { ...wire, elapsedMs: -1 },
    { ...wire, bestScore: null },
    { ...wire, staleness: { products: [["bad"]], sources: [] } },
  ]) {
    expect(() => JhController.decode(invalid)).toThrow()
  }
  const missing = { ...wire }
  delete missing.gateChecks
  expect(() => JhController.decode(missing)).toThrow()
})
