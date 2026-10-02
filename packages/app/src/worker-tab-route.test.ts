import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

/**
 * 🔴 **"Too many redirects" when opening a worker from the Running workers list.**
 *
 * The route effect in `titlebar.tsx` collapsed a sub-agent session onto its PARENT's session id and
 * left `agent` undefined. `app.tsx` separately asked `session.root.parentID` whether the tab was a
 * worker — but the root of a lineage never has a parent, so the flag was always false and it opened
 * the officer's tab instead. The strip's one-tab-per-colleague reconciliation then saw the anonymous
 * parent tab race the officer's own tab, called `removeTab`, and `removeTab` NAVIGATES to a
 * neighbouring tab. The route re-reconciled into the same fold, and the router refused the chain at
 * its 20-redirect ceiling.
 *
 * The invariant is already written down in `context/tab-agent.ts`: a worker tab carries
 * `worker: true`, and both `findAgentTab` and `noteSessionAgent` skip it. That is what keeps a
 * worker's own chat from colliding with — and folding into — the officer that spawned it. These two
 * assertions hold the ROUTE effects to it; the pure decision is covered in `tabs-invariant.test.ts`.
 *
 * A/B: restore `session.root.parentID` in `app.tsx` (or `s.parentID ?? s.id` in `titlebar.tsx`) and
 * the corresponding assertion fails.
 */
const SRC = path.resolve(import.meta.dir)

const read = (rel: string) => readFileSync(path.join(SRC, rel), "utf8")

/** Prose quotes the defect it describes, so structural assertions read code, not comments. */
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")

describe("opening a worker opens the WORKER's tab", () => {
  test("app.tsx decides from the route's own session, not the lineage root", () => {
    const app = code(read("app.tsx"))
    expect(
      app,
      "`session.root.parentID` is always undefined, so the worker flag never applies — read the resolved session",
    ).not.toContain("session.root.parentID")
    expect(app).toContain('session.session.type === "sub-agent"')
    expect(app).toContain("worker: true")
  })

  test("titlebar does not collapse a sub-agent route onto its parent's session", () => {
    const titlebar = code(read("components/titlebar.tsx"))
    expect(
      titlebar,
      "collapsing a sub-agent to `s.parentID ?? s.id` creates the anonymous parent tab the strip then folds away",
    ).not.toContain("s.parentID ?? s.id")
    expect(titlebar).toContain("collapsesIntoParent(s)")
    expect(titlebar).toContain("worker: true")
  })
})
