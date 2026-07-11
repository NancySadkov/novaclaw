export * as JhRegression from "./regression"

// jh — the persistent regression suite (jh-improve4 P1 / §I6 the "unlocked foundation" finding). A registry
// of the model's OWN passing run/output_equals checks that execute a workspace product (a compiled test
// binary), keyed by the normalized run command. This is the staleness "make" discipline applied to TESTS,
// not just binaries: after a source edit, the tests whose dependency digest changed are RE-RUN before the
// leaf's own check, so a previously-green primitive test that a later edit silently broke fails IMMEDIATELY
// and names the file that broke it — instead of the model thrashing the formula while the real bug is in the
// foundation (run75: `pi.c` edited 74× while the bug was a `bigint` precision error whose weak one-shot test
// had passed and was never re-run). Pure + deterministic — no fs, no clock; the engine feeds it digests +
// results. Engine-run-scoped, in-memory (jh-improve1 L4 — not persisted in State this wave).

export interface TestEntry {
  readonly command: string // normalized run command (the registry key)
  readonly expect?: string // carried from the check that registered it (a substring the output must contain)
  readonly depsDigest: string // staleness source-digest at the last source state this test was EXECUTED against
  readonly failures: number // consecutive regression failures across fix attempts (jh-improve4 P4's re-derive trigger)
  /** improve6 P3: a SUSPECT test may itself be wrong (its own file doesn't compile, or it stays red while
   *  the program's output demonstrably improves — run101 died 29× on a t_arctan whose expectation was
   *  mathematically impossible). Suspect tests still run + report but LOSE THEIR VETO (excluded from the
   *  phase gate and from build-damage): registered tests must not be infallible by construction. */
  readonly suspect: boolean
  /** improve6 P3: registered from a run whose output carried `implicit declaration` warnings — the test
   *  file likely misses the unit's header (wrong implicit prototypes). Its FIRST failure makes it
   *  suspect-eligible immediately (no SUSPECT_AFTER wait). */
  readonly unsanitized: boolean
}

export interface Registry {
  readonly register: (input: { readonly command: string; readonly expect?: string; readonly depsDigest: string }) => void
  /** the registered tests whose stored digest ≠ the current one (`digestOf(command)`) — i.e. NOT executed
   *  against the current source state, so they must be re-run before we trust the foundation. */
  readonly staleTests: (digestOf: (command: string) => string) => ReadonlyArray<TestEntry>
  /** record a re-run's outcome: on PASS refresh the digest (validated at this source state) + clear the
   *  failure streak; on FAIL refresh the digest (executed at this state — re-run once per source change,
   *  not every step) + bump the consecutive-failure count that drives P4. */
  readonly recordResult: (command: string, ok: boolean, depsDigest: string) => void
  /** improve6 P3: mark a test SUSPECT (it keeps its entry + keeps running, but loses its veto). */
  readonly markSuspect: (command: string) => void
  /** improve6 P3: mark a test as registered-with-warnings (implicit declarations at registration/pass). */
  readonly markUnsanitized: (command: string) => void
  readonly all: () => ReadonlyArray<TestEntry>
  /** drop any registered test whose product no longer exists (deleted/renamed) — `productExists(command)`. */
  readonly prune: (productExists: (command: string) => boolean) => void
}

/** normalize a run command to its registry key — trim + collapse internal whitespace so cosmetic spacing
 *  differences (`.\t_mul.exe` vs `.\t_mul.exe `) don't register two entries for the same test. */
export const normalizeCommand = (command: string): string => command.trim().replace(/\s+/g, " ")

export function registry(): Registry {
  const tests = new Map<string, TestEntry>() // normalized command → entry (insertion order = registration order)

  const register: Registry["register"] = ({ command, expect, depsDigest }) => {
    const key = normalizeCommand(command)
    if (key === "") return
    const prev = tests.get(key)
    // Re-registration updates the digest (seen green again at a newer source state), resets the failure
    // streak, AND clears `suspect` — the test just PASSED as a leaf's own check, so the suspicion is
    // withdrawn (a replaced/fixed test re-earns trust the same way it earned registration). `unsanitized`
    // clears too only if the re-registering pass was clean (the caller re-marks when it wasn't).
    tests.set(key, { command: key, expect: expect ?? prev?.expect, depsDigest, failures: 0, suspect: false, unsanitized: false })
  }

  const staleTests: Registry["staleTests"] = (digestOf) => {
    const out: TestEntry[] = []
    for (const e of tests.values()) if (digestOf(e.command) !== e.depsDigest) out.push(e)
    return out
  }

  const recordResult: Registry["recordResult"] = (command, ok, depsDigest) => {
    const key = normalizeCommand(command)
    const prev = tests.get(key)
    if (!prev) return
    tests.set(key, { ...prev, depsDigest, failures: ok ? 0 : prev.failures + 1 })
  }

  const markSuspect: Registry["markSuspect"] = (command) => {
    const key = normalizeCommand(command)
    const prev = tests.get(key)
    if (prev) tests.set(key, { ...prev, suspect: true })
  }

  const markUnsanitized: Registry["markUnsanitized"] = (command) => {
    const key = normalizeCommand(command)
    const prev = tests.get(key)
    if (prev) tests.set(key, { ...prev, unsanitized: true })
  }

  const all: Registry["all"] = () => [...tests.values()]

  const prune: Registry["prune"] = (productExists) => {
    for (const key of [...tests.keys()]) if (!productExists(key)) tests.delete(key)
  }

  return { register, staleTests, recordResult, markSuspect, markUnsanitized, all, prune }
}
