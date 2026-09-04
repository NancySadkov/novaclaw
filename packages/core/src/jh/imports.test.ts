import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "../../test/lib/source-scan"

// §0.7.2 — mechanical import-whitelist guard. Every engine source file under src/jh/ may import ONLY:
//   effect · ./… (jh-relative) · ../util/hash · node:… (process-runner/tools-basic/store only) ·
//   drizzle-orm/… (sql.ts only) · ../database/… (store.ts only).
// This keeps jh out of the LocationServiceMap and away from session/tool/config/v1/llm REACH, so
// Phases 1–13 cannot collide with F1 deletions. The guard scans the directory, so it grows as files
// appear — a new engine file with a stray import fails this test, not a downstream typecheck.

const DIR = import.meta.dir

const NODE_ALLOWED = new Set(["process-runner.ts", "tools-basic.ts", "store.ts"])

function violationFor(filename: string, spec: string): string | undefined {
  if (spec === "effect") return undefined
  if (spec.startsWith("./")) return undefined
  if (spec === "../util/hash") return undefined
  // improve18: the PURE affective homeostat (core root, zero dependencies) — Strict and the normal
  // drain loop must drive ONE engine, not two look-alikes. Whitelisted on the same grounds as
  // ../util/hash: a leaf module, no session/tool/config/v1/llm/schema reach (which is what §0.7.2
  // actually guards).
  if (spec === "../affective") return undefined
  // C2 (v0.2.0-prep Wave 1): THE one process-tree kill. Whitelisted on exactly the same grounds as
  // ../util/hash — `src/util/kill-tree.ts` imports `node:` builtins and NOTHING else, so it carries
  // no session/tool/config/v1/llm/schema reach (which is what §0.7.2 actually guards). It is a leaf
  // precisely BECAUSE of this rule: `../shell` re-exports the same function but drags Flag/FSUtil/
  // ShellBundle/Global behind it, and jh must not reach those. Do NOT relax this to "../shell".
  if (spec === "../util/kill-tree") return undefined
  // The workspace-render budget (2026-09-02) needs a token estimate to size the render against
  // `limits.context`. `src/util/token.ts` imports NOTHING AT ALL — a pure estimator over a string —
  // so it carries no session/tool/config/v1/llm/schema reach, which is what §0.7.2 actually guards.
  // Same grounds as `../util/hash` and `../util/kill-tree` above.
  if (spec === "../util/token") return undefined
  // logging 1b (2026-08-06): jh's ONE log call became a declared event, which needs the keyed
  // wrapper. Whitelisted on exactly the grounds this guard states for `../util/hash` and
  // `../util/kill-tree` — `@novaclaw/schema/log` imports `effect` and `./log-events`, and
  // `log-events.ts` imports NOTHING at all. It is a static table plus one function, so it carries no
  // session/tool/config/v1/llm reach.
  //
  // ⚠️ **This is the one entry that reads as a contradiction, so read it carefully.** The header says
  // jh stays "off the … schema tree", and this is a schema import. The header names TREES; every
  // justification in this function names REACH, and reach is what the guard can actually be violated
  // by. `schema/log` is a leaf by construction and is tested to stay one (`log-events.test.ts`). Do
  // NOT read this as opening `@novaclaw/schema/*` generally — the rest of that package pulls the
  // session and config shapes jh must not see.
  if (spec === "@novaclaw/schema/log") return undefined
  // 2026-08-19: the three-answer presence probe. `verifier.ts` and `engine.ts` take it as a TYPE ONLY
  // (`import type`), so this adds no runtime edge whatsoever — the specifier is erased at compile and
  // jh's bundle is byte-identical. Even as a value it would qualify on exactly the `../util/kill-tree`
  // grounds this function already states: `src/presence.ts` imports `node:fs` and `node:fs/promises`
  // and NOTHING else, so it carries no session/tool/config/v1/llm/schema reach.
  //
  // Why the gate needed it at all: `file_exists` reported a path it COULD NOT READ as "file not found",
  // writing an observation the gate never made into the transcript the model reasons from — which is
  // the one thing jh.md §5 law 4 exists to prevent, since the gate is supposed to be the objective
  // check. Answering that honestly needs three values, and this is where the third one is defined.
  if (spec === "../presence") return undefined
  if (spec.startsWith("node:")) {
    return NODE_ALLOWED.has(filename) ? undefined : `node: import "${spec}" not allowed in ${filename}`
  }
  if (spec.startsWith("drizzle-orm")) {
    // sql.ts declares the tables; store.ts (the DB seam) needs the query helpers (eq/asc).
    return filename === "sql.ts" || filename === "store.ts"
      ? undefined
      : `drizzle-orm import "${spec}" only allowed in sql.ts/store.ts (got ${filename})`
  }
  if (spec.startsWith("../database/")) {
    return filename === "store.ts"
      ? undefined
      : `../database import "${spec}" only allowed in store.ts (got ${filename})`
  }
  return `disallowed import "${spec}" in ${filename}`
}

function specifiersOf(source: string): string[] {
  // Scan comment-stripped source; a real module specifier never contains whitespace, so anything with
  // a space (a stray `from "..."` in a string literal or comment fragment) is discarded as noise.
  const stripped = stripComments(source)
  const specs: string[] = []
  let m: RegExpExecArray | null
  const from = /\bfrom\s+["']([^"']+)["']/g
  while ((m = from.exec(stripped)) !== null) specs.push(m[1]!)
  const sideEffect = /(?:^|[\n;])\s*import\s+["']([^"']+)["']/g // `import "..."` side-effect form
  while ((m = sideEffect.exec(stripped)) !== null) specs.push(m[1]!)
  return specs.filter((s) => !/\s/.test(s))
}

const engineFiles = readdirSync(DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))

describe("jh import whitelist", () => {
  test("at least the Phase-1 engine files are present", () => {
    expect(engineFiles).toContain("step.ts")
    expect(engineFiles).toContain("extract.ts")
  })

  for (const filename of engineFiles) {
    test(`${filename} imports only whitelisted specifiers`, () => {
      const source = readFileSync(join(DIR, filename), "utf8")
      const violations = specifiersOf(source)
        .map((spec) => violationFor(filename, spec))
        .filter((v): v is string => v !== undefined)
      expect(violations).toEqual([])
    })
  }
})
