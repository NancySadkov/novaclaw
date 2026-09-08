import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

/**
 * A SOURCE ledger: every capability the community stores expose has a caller outside its own file.
 *
 * 🔴 This exists because the same defect recurred four times while the program was built, and each
 * time it was caught by hand an iteration later. `CommunityPost` shipped with no consumer;
 * `CommunitySuccession.resolve` had none for two commits; `followAll` was written and nearly left
 * the same way. An orphan is not merely dead weight — it is a capability nobody has exercised, and
 * twice the act of wiring one up exposed a real defect behind it (order-dependent rotation
 * following, and a block that a rotation could clear).
 *
 * ⚠️ Deliberately counts TEST callers as insufficient. A method exercised only by its own unit test
 * proves it runs, never that anything needs it — which is exactly the state each of those four was
 * in when it looked finished.
 */

const root = path.join(import.meta.dir, "..", "src")
const communityDir = path.join(root, "community")

/**
 * Modules outside `community/` that this program owns and that must obey the same rule.
 *
 * ⚠️ Added after the ledger caught its own blind spot: `InstanceIdentityStore.rotate` had no caller
 * at all, and P1 had been declared CLOSED on the strength of the capability existing rather than
 * being reachable. A guard scoped to one directory only proves things about that directory.
 */
const EXTRA_MODULES = [path.join(root, "instance-identity-store.ts")]

/**
 * Exported FUNCTIONS of a module that has no `Interface` — the other shape a capability takes.
 *
 * ⚠️ Added after this ledger missed three modules in a row. `search.ts`, `work.ts` and
 * `reconcile.ts` export plain functions rather than a service, so a guard that only read
 * `export interface Interface` could not see them, and all three sat with zero consumers while the
 * guard reported green. A guard that checks ONE shape proves things about that shape.
 */
const exportedFunctions = (source: string): string[] => {
  if (source.includes("export interface Interface {")) return []
  return [...source.matchAll(/export const (\w+) = \(/g)].map((match) => match[1]!)
}

/**
 * Method names on a module's `Interface` — members typed as a FUNCTION.
 *
 * ⚠️ Matching `readonly (\w+):` alone also caught plain data fields (`networkID`, `muted`,
 * `stored`), which are not capabilities and can have no caller. A guard that reports fields as
 * orphans is a guard people learn to ignore, so the arrow is required.
 */
const declaredMethods = (source: string): string[] => {
  const start = source.indexOf("export interface Interface {")
  if (start < 0) return []
  const end = source.indexOf("\n}", start)
  const block = source.slice(start, end)
  return [...block.matchAll(/readonly (\w+): \(/g)].map((match) => match[1]!)
}

/**
 * 🔴 Namespaces whose `.method(` is NEVER a call to one of our capabilities.
 *
 * This ledger used to ask `other.includes(".${method}(")` and called that *"loose on purpose: a
 * false NEGATIVE here just means the ledger stays quiet"*. It did not stay quiet — it stayed WRONG,
 * and it hid the largest defect of the program: `sync.ts#sync` had no production caller for as long
 * as it existed, and this guard reported it used because **`Effect.sync(` contains `.sync(`**. The
 * one capability whose name collided with the most common combinator in the codebase was the one
 * nothing called.
 *
 * ⚠️ The original reasoning traded a false negative for the risk of exemptions becoming decoration.
 * That trade is only sound when the miss is random; here it is SYSTEMATIC — it fires precisely on
 * the names a framework also uses (`sync`, `filter`, `get`, `all`), so the guard was blindest
 * exactly where a service method is most ordinarily named.
 */
const FRAMEWORK = new Set([
  "Effect",
  "Layer",
  "Schema",
  "Option",
  "Either",
  "Cause",
  "Exit",
  "Fiber",
  "Stream",
  "Chunk",
  "Duration",
  "Clock",
  "Console",
  "Context",
  "Ref",
  "Deferred",
  "Queue",
  "Scope",
  "Predicate",
  "Array",
  "Record",
  "String",
  "Number",
  "Boolean",
  "Object",
  "JSON",
  "Math",
  "Promise",
  "Date",
  "Order",
  "Equal",
  "Hash",
  "Struct",
  "Tuple",
  "Data",
  "Match",
  "Config",
  "Logger",
  "Metric",
])

/**
 * Whether `source` calls `.method(` on something that is not a framework namespace.
 *
 * ⚠️ Still deliberately loose about WHICH of our objects the receiver is — a service is reached
 * through a local name (`const sync = yield* CommunitySync.Service`) and chasing that would make
 * this a type checker. Excluding the namespaces that are definitionally not ours is enough to close
 * the systematic hole without inviting exemptions.
 */
const calls = (source: string, method: string): boolean => {
  const needle = "." + method + "("
  for (let at = source.indexOf(needle); at >= 0; at = source.indexOf(needle, at + 1)) {
    let start = at
    while (start > 0 && /[A-Za-z0-9_$]/.test(source[start - 1]!)) start--
    if (!FRAMEWORK.has(source.slice(start, at))) return true
  }
  return false
}

/**
 * The namespace a module is re-exported under — `export * as CommunitySync from "./sync"`.
 *
 * 🔴 The second half of the fix, and the first half alone was NOT enough. Excluding framework
 * receivers still counted `serverSession.session.sync(id)` in the app as a caller of the community's
 * `sync`: the collision is not only with `Effect.sync`, it is with any object anywhere that happens
 * to have a method of the same name. A real caller must first GET the service, and the only way to
 * do that is through this namespace — so a file that never mentions it cannot be calling into it.
 */
const namespaceOf = (source: string): string | undefined => /export \* as (\w+) from/.exec(source)?.[1]

/** Every .ts file under src, minus the file that declares the method. */
const sourcesExcept = (exclude: string): string[] => {
  const files: string[] = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      /**
       * ⚠️ `.tsx` TOO, and its absence was a real blind spot (found 2026-08-18): the app's callers
       * are components, so a capability used ONLY from the UI read as an orphan here and would have
       * been reported as dead code to whoever came to prune it. `community/address.ts` was flagged
       * the moment the Community panel became its only external caller.
       */ else if (
        (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
        !entry.name.endsWith(".test.ts") &&
        !entry.name.endsWith(".test.tsx") &&
        full !== exclude
      )
        files.push(full)
    }
  }
  walk(root)
  // The app and server live in other packages; their calls count too, so include them when present.
  for (const sibling of ["novaclaw/src", "app/src"]) {
    const dir = path.join(root, "..", "..", sibling)
    if (fs.existsSync(dir)) walk(dir)
  }
  return files
}

/**
 * Capabilities with no caller yet, each naming the CONSUMER it is waiting for.
 *
 * ⚠️ "Not wired up yet" is not a reason — that is precisely the state this ledger exists to expose.
 * An entry must name what will call it and why that thing does not exist, so the list shrinks as
 * those arrive rather than becoming a place to hide things.
 */
const EXPECTED_ORPHANS: Record<string, string> = {
  /**
   * 🔴 Every entry below is an exported INTERNAL helper — a same-file caller, which this guard
   * cannot see because it deliberately counts callers OUTSIDE the declaring file. Tightening it to
   * accept same-file callers would hide real orphans in big modules, so the exemption carries the
   * reason instead. **Nothing here is "not wired up yet"**; that state is what the ledger exists to
   * expose, and an entry claiming it would be the ledger hiding work from itself.
   *
   * ⚠️ This block used to be wrapped in prose describing a product that no longer exists. Six
   * claims, all false by the time they were read: that the transport "is the one piece of this
   * program that does not exist" (it shipped), that rotation "must STAY unreachable until P2" (it is
   * in Settings), that Leave and Mute are "deliberately NOT exposed" pending channel discovery (both
   * are in the panel), that nothing can carry a search query (`/search-channels` answers one), that
   * the sealing envelope waits on "the DM feature itself" (DMs ship), and that `topicOf` waits for a
   * transport to need it.
   *
   * 🔴 Each was true when written, and each was left behind when its ENTRY was deleted on wiring —
   * the comment outlived the thing it explained. That is the same failure this program has now hit
   * three times (a step named for what it did not test, a note saying a surface could not be
   * tested): **a wrong sentence about coverage or state does not fail, it just stops the looking.**
   * Prose about what is NOT built belongs in the roadmap, which is pruned; a guard should describe
   * only what it is exempting, right now.
   */
  "reconcile.ts#idsIn":
    "internal helper: `answerIds` in this same file is what the wire calls — it applies the bucket and id ceilings the anonymous door needs (Codex P1), and a caller reaching past it would be reaching past the bound. Exported so the UNBOUNDED shape stays testable beside the bounded one",
  "admission.ts#make":
    "test-only constructor: the product uses the process-wide `current()`, exactly as `Offline` and `CommunityConsent` do — a per-request governor is a governor that resets every request, which is one that does nothing. Exported so the counters can be exercised without touching the live one",
  "admission.ts#reset":
    "test-only: forgets the process-wide counters so one file's flood cannot refuse the next file's first request. Its callers live in `packages/novaclaw`'s server tests, which this ledger does not scan",
  "contacts.ts#follow":
    "internal helper: followAll walks the chain link by link with it, and followAll IS the caller the network reaches — a bag of statements arrives unordered, so single-stepping is never the entry point",
  "search.ts#consider":
    "internal: the wire in this same file calls it on every received query — it is the door, not a capability waiting for one",
  "search.ts#widen":
    "internal: `broadcast` in this same file waves through it, widening only when a wave under-delivers",
  "address.ts#splitAnnounce":
    "internal helper: `isAnnounceable` in this same file IS its only caller — exported so the parse can be pinned directly, which is the half that was wrong before (a regex accepted `example.com:99999` and rejected `[2001:db8::1]:4096`). Asserting host and port beats inferring them from a boolean",
  "dht.ts#parse":
    "internal helper: `find` in this same file parses the sidecar's reply with it — exported so the validation of data that arrived from strangers through a DHT can be tested without spawning a Rust binary",
  "dht.ts#binaryPath":
    "internal helper: `find` resolves the sidecar through it — exported so a packaged build can be pointed at its own copy and so the override can be asserted",
  "seeds.ts#parse":
    "internal helper: `resolve` in this same file calls it on whatever DNS returned — exported so the chunk-joining and the bound can be exercised without a network, which is the part most likely to be wrong",
  "reconcile.ts#bucketOf":
    "internal helper called by summarize/idsIn in the same file; exported to test the both-sides-agree rule",
  "seal.ts#parsePublic":
    "internal helper used by seal/unseal in the same file; exported to test that a peer's malformed key is refused rather than thrown on",
  "work.ts#solve":
    "internal helper called by prove() in the same file; exported so the difficulty table in `work.test.ts` can be measured directly",
}

/**
 * Every source file's TEXT, read once and shared by all of these tests.
 *
 * ⚠️ This used to be `sourcesExcept(file).map(readFileSync)` INSIDE each test, so ~25 tests each
 * read ~700 files — the whole tree, once per module. It crossed bun's 5 s default the moment the
 * subsystem grew one more module, and it read as a flaky test rather than as a quadratic one.
 * Caching by path keeps the exclusion honest (a module still never counts as its own caller) while
 * reading each file at most once.
 */
const sourceText = new Map<string, string>()
const readSources = (exclude: string): string[] =>
  sourcesExcept(exclude).map((other) => {
    const cached = sourceText.get(other)
    if (cached !== undefined) return cached
    const text = fs.readFileSync(other, "utf8")
    sourceText.set(other, text)
    return text
  })

describe("community capabilities have callers", () => {
  const modules = [
    ...fs
      .readdirSync(communityDir)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".sql.ts") && !name.endsWith(".test.ts"))
      .map((name) => path.join(communityDir, name)),
    ...EXTRA_MODULES,
  ]

  for (const file of modules) {
    const moduleName = path.basename(file)
    const source = fs.readFileSync(file, "utf8")
    const methods = [...declaredMethods(source), ...exportedFunctions(source)]
    const namespace = namespaceOf(source)
    if (methods.length === 0) continue

    test(`${moduleName}: ${methods.length} capability(ies) are each used somewhere`, () => {
      const others = readSources(file)
      const orphans = methods.filter((method) => {
        const key = `${moduleName}#${method}`
        if (key in EXPECTED_ORPHANS) return false
        return !others.some((other) => (namespace === undefined || other.includes(namespace)) && calls(other, method))
      })
      expect(orphans, `${moduleName} declares capabilities nothing calls: ${orphans.join(", ")}`).toEqual([])
    })
  }
})
