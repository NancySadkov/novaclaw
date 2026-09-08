import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

/**
 * The instance graph BUILDS the fleet watcher, and the registry it reads is wired to a worker's life.
 *
 * 🔴 Same hazard as `agent-removal-wiring.test.ts`, and the same reason a unit test cannot see it:
 * importing a node without listing it compiles green and ships dead. Here that would mean an
 * instance with no fleet view at all — the exact state this work exists to end, restored silently.
 *
 * ⚠️ The registry half matters just as much and fails the other way. If `register` is called and the
 * release is not wired to EVERY exit, the fleet view fills with pids of processes that are gone —
 * and a pid the OS has since handed to somebody else. Over-reporting a fleet is how a future kill
 * path shoots a stranger, so the `ensuring` is asserted, not just the `register`.
 */

const read = (...segments: string[]) =>
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ...segments), "utf8")

const server = read("src", "server", "routes", "instance", "httpapi", "server.ts")
const execution = read("src", "session-worker", "execution.ts")

describe("the instance graph carries the fleet watcher", () => {
  test("the node is in the list, not merely imported", () => {
    expect(server).toContain("WorkerWatch.node,")
  })

  test("it is imported from the module that owns the tick", () => {
    expect(server).toContain('from "@/storage/worker-watch"')
  })

  test("it sits beside the spawn-pressure node — both are host-memory guards", () => {
    const watch = server.indexOf("WorkerWatch.node,")
    const pressure = server.indexOf("SpawnPressure.node,")
    expect(watch).toBeGreaterThan(0)
    expect(pressure).toBeGreaterThan(0)
    // Adjacent so the two halves of "can this host afford it" are read together: one refuses new
    // work at the door, the other watches what is already inside.
    expect(Math.abs(watch - pressure)).toBeLessThan(500)
  })
})

describe("a worker's registration matches its life", () => {
  test("execution admission runs before a process can start", () => {
    expect(execution).toContain('from "./admission"')
    expect(execution).toContain("return yield* workerAdmission.run(")
    expect(execution.indexOf("workerAdmission.run")).toBeLessThan(execution.indexOf("SessionWorkerSupervisor.spawn"))
  })

  test("execution registers the spawned worker", () => {
    expect(execution).toContain("WorkerRegistry.register(")
    expect(execution).toContain("pid: spawned.value.pid")
  })

  test("🔴 the release is wired to EVERY exit, not just the happy one", () => {
    // `ensuring` runs on success, failure AND interrupt. `onInterrupt` alone would leak an entry for
    // every worker that merely failed — and a leaked entry names a pid that may now belong to
    // somebody else's process.
    expect(execution).toMatch(/Effect\.ensuring\(Effect\.sync\(releaseWorker\)\)/)
  })

  test("NEGATIVE CONTROL: the reader would notice if the release went away", () => {
    expect(
      /Effect\.ensuring\(Effect\.sync\(releaseWorker\)\)/.test("Effect.ensuring(Effect.sync(releaseWorker))"),
    ).toBe(true)
    expect(/Effect\.ensuring\(Effect\.sync\(releaseWorker\)\)/.test("outcome = yield* Effect.promise(...)")).toBe(false)
  })
})
