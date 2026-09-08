import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

/**
 * ROSTER SURFACES MUST NOT CRASH THE APP OR HIRE OVER A COLLEAGUE.
 *
 * Two residues, both of which only show up when the roster fetch FAILS — which is exactly when
 * nobody is looking:
 *
 *   · Three pages each built their own `listAgents` resource with no `.catch`. A `createResource`
 *     read from an eager memo rethrows, so one rejected roster fetch reached the root ErrorBoundary
 *     and replaced the WHOLE UI with the error page.
 *   · Hire stayed enabled on a roster error. `agents()` degrades to `[]`, and `planHire` draws from
 *     the ids NOT taken — so an empty roster reads as "every name is free" and the drawn id can land
 *     on a colleague who already has it, handing the new hire their cabinet, chat and spend.
 *
 * Source assertions, in the house style of `dialog-model-config.test.ts`: the claim is about how a
 * surface is WIRED, and neither failure is reachable from a unit test without standing up the whole
 * page and a failing server.
 */

const read = (...parts: string[]) => fs.readFileSync(path.join(import.meta.dir, ...parts), "utf8")

describe("no page owns a second, uncaught roster fetch", () => {
  test("🔴 calendar reads the server context's shared roster", () => {
    const source = read("calendar.tsx")
    expect(source).toContain("rosterCtx()?.agents.list()")
    expect(source).not.toContain("listAgents(")
  })

  test("🔴 memory-graph reads the server context's shared roster", () => {
    const source = read("memory-graph.tsx")
    expect(source).toContain("ctx()?.agents.list()")
    expect(source).not.toContain("listAgents(")
  })

  test("🔴 the composer reads the shared roster too — all three, no exceptions", () => {
    // It was the one holdout, on the belief that this scope had only an SDK client. It does not:
    // `const server = useServer()` sits in the same function, so `ensureServerCtx` was always
    // reachable. Sharing the roster removes the third fetch AND makes a rename visible.
    const source = read("session", "composer", "session-composer-controls.ts")
    expect(source).toContain("rosterCtx()?.agents.list()")
    expect(source).not.toContain("listAgents(")
  })
})

describe("a rename made from a CHAT", () => {
  const source = fs.readFileSync(
    path.join(import.meta.dir, "..", "components", "composer", "features-control.tsx"),
    "utf8",
  )

  test("🔴 the composer's Tune refreshes the roster on save", () => {
    // It used to omit `onChanged` deliberately — "opened from a CHAT, there is no roster on screen to
    // refresh" — which was true until the composer's own chip started reading the roster for a display
    // NAME. After that, a rename left the chip showing the old one and the save looked like it failed.
    expect(source).toContain("agents.refetch()")
    expect(source).not.toContain("No `onChanged` here on purpose")
  })
})

describe("hiring off a roster we could not read", () => {
  test("🔴 Hire is disabled on a roster ERROR, not only while loading", () => {
    const source = read("contacts.tsx")
    expect(source).toContain("disabled={hiring() || agentsLoading() || agentsError() !== undefined}")
  })

  test("…and the error state is actually derived, not assumed", () => {
    // If this accessor disappears the guard above silently becomes `undefined !== undefined` = false.
    expect(read("contacts.tsx")).toContain("const agentsError = () => ctx()?.agents.error()")
  })
})

describe("clone is available on every Contacts entry", () => {
  test("both the visible and hidden rosters wire their rows to the shared clone action", () => {
    const source = read("contacts.tsx")
    expect(source.match(/onClone=\{\(\) => void cloneColleague\(view\.id\)\}/g)).toHaveLength(2)
    expect(source).toContain('data-action="contacts-clone"')
    expect(source).toContain("cloneAgent({")
  })
})
