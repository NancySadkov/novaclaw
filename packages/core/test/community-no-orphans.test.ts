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
  "contacts.ts#follow": "waiting for P2: successor statements arrive over the network",
  "contacts.ts#followAll": "waiting for P2: a bag of statements arrives from a gossip mesh",
  // Deliberately NOT exposed. With one channel and no way to join others, a Leave button's only
  // effect is to empty the screen, and Mute has nothing to mute against. Both become real with
  // channel discovery in P5; shipping the controls first would be UI for a situation nobody is in.
  "channels.ts#leave": "deliberate: meaningless until P5 lets a user join more than one channel",
  "channels.ts#setMuted": "deliberate: meaningless until P5 lets a user join more than one channel",
}

describe("community capabilities have callers", () => {
  const modules = fs
    .readdirSync(communityDir)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".sql.ts") && !name.endsWith(".test.ts"))

  for (const moduleName of modules) {
    const file = path.join(communityDir, moduleName)
    const source = fs.readFileSync(file, "utf8")
    const methods = declaredMethods(source)
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
