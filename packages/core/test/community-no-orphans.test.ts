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

/** Every .ts file under src, minus the file that declares the method. */
const sourcesExcept = (exclude: string): string[] => {
  const files: string[] = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && full !== exclude) files.push(full)
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
  // Statements arrive from PEERS. The caller is the transport's inbound path (P2), which is the one
  // piece of this program that does not exist — the same reason `record` was test-only until the
  // HTTP surface landed.
  "contacts.ts#follow": "internal helper: followAll walks the chain link by link with it, and followAll IS the caller the network reaches — a bag of statements arrives unordered, so single-stepping is never the entry point",
  // Deliberately NOT exposed. With one channel and no way to join others, a Leave button's only
  // effect is to empty the screen, and Mute has nothing to mute against. Both become real with
  // channel discovery in P5; shipping the controls first would be UI for a situation nobody is in.
  // 🔴 Deliberately unreachable, and it must STAY that way until P2. Rotating issues a successor
  // statement that no peer can receive without a transport, so a user who rotated today would
  // silently strand themselves: new key, nobody told, and the proof undeliverable. The capability is
  // built and tested; exposing it is P2's job, not P1's.
  // Queries and summaries arrive FROM PEERS. Built ahead of the transport deliberately — these are
  // the controls whose absence collapsed Gnutella, and they are cheaper to get right in a test than
  // in a mesh — but nothing local can call them until something carries a query.
  "search.ts#consider": "internal: the wire in this same file calls it on every received query — it is the door, not a capability waiting for one",
  "search.ts#widen": "internal: `broadcast` in this same file waves through it, widening only when a wave under-delivers",
  "reconcile.ts#bucketOf": "internal helper called by summarize/idsIn in the same file; exported to test the both-sides-agree rule",
  // ✅ WIRED since the note above was written: `post` calls `prove`, `record` calls `verify`, and
  // the signed envelope carries a nonce. `solve` remains listed only because this guard counts
  // callers OUTSIDE the declaring file, and `solve`'s caller is `prove` in the same module — it is
  // exported so the difficulty table in `work.test.ts` can be measured directly.
  //
  // ⚠️ That is a known weakness of the rule: an exported INTERNAL helper looks identical to an
  // orphan. Tightening it to ignore same-file callers would hide real orphans in big modules, so the
  // exemption carries the reason instead.
  /**
   * The DM envelope, built before the feature that carries it — the same order the message envelope,
   * reconciliation and the search controls used, and for the reason §11 gave: this is the most
   * dangerous code in the program and it is cheaper to get right in a test than in a mesh.
   *
   * ⚠️ What it is waiting for is NOT a transport. It is the DM feature itself: publishing a sealing
   * key signed by the identity, and a message type that carries an envelope. Those are the next wire.
   */
  "seal.ts#parsePublic": "internal helper used by seal/unseal in the same file; exported to test that a peer's malformed key is refused rather than thrown on",
  /**
   * P6's first slice: an instance can SIGN what it offers, and nothing serves or fetches one yet.
   * The remaining wire is a peer endpoint that returns `mine()` and a collector that gathers peers'
   * offers during discovery — the same shape the sealing key and listed channels already use.
   *
   * ⛔ Payment stays unbuilt on purpose. The ledger says Lightning is LAST and without custody, and
   * moving money is a decision with legal weight rather than a next step in an advertisement format.
   */
  "offer.ts#publish": "waiting for the offer surface: nothing lets a user declare one yet",
  "offer.ts#withdraw": "waiting for the offer surface",
  "offer.ts#mine": "waiting for the peer endpoint that serves it",
  "work.ts#solve": "internal helper called by prove() in the same file; exported for measurement",
  // THE inbound door. A sidecar is a separate process holding only a topic id, so it calls this —
  // and nothing in-process does, by design: an in-process caller already knows the channel name and
  // should use `record`.
  // The transport needs `topicOf` to know which topic to publish to; until one exists, its only
  // caller is `channelFor` beside it. `canonical` is `topicOf`'s own helper, exported so the
  // normalisation decision — that #NovaClaw and #novaclaw are ONE room — is directly testable.
}

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
    if (methods.length === 0) continue

    test(`${moduleName}: ${methods.length} capability(ies) are each used somewhere`, () => {
      const others = sourcesExcept(file).map((other) => fs.readFileSync(other, "utf8"))
      const orphans = methods.filter((method) => {
        const key = `${moduleName}#${method}`
        if (key in EXPECTED_ORPHANS) return false
        // `.method(` anywhere outside the declaring file. Loose on purpose: a false NEGATIVE here
        // just means the ledger stays quiet, while a false positive would train people to add
        // exemptions, which is how a guard becomes decoration.
        return !others.some((other) => other.includes(`.${method}(`))
      })
      expect(orphans, `${moduleName} declares capabilities nothing calls: ${orphans.join(", ")}`).toEqual([])
    })
  }
})
