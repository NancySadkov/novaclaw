import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "@novaclaw/core/test/source-scan"

/**
 * 🔴 A CORS DIAGNOSTIC NOBODY CALLS IS NOT A DIAGNOSTIC.
 *
 * Measured 2026-09-29, packaged 0.1.81: a client was refused with "No 'Access-Control-Allow-Origin'
 * header is present" on `/log`, `/provider` and `/path`, and minutes later a live probe of the same
 * routes on the same port answered 204 with the correct header — including the `authorization`
 * preflight the renderer actually sends. The policy was right, so something else answered, and WHICH
 * LAYER did it was unanswerable: the server records only what it handled, so a preflight answered
 * upstream of the CORS middleware leaves no trace. The client's console names the symptom, not the
 * cause.
 *
 * The boot cost 34.9 s and could not be explained. This exists so the next one explains itself.
 *
 * These cases hold the WIRING and the LOGIC, because both fail silently. The behaviour needs a live
 * server, which is precisely what is missing at 3am when a boot goes wrong.
 */
// …/packages/novaclaw/test/server → up four reaches the repo root.
const ROOT = join(import.meta.dir, "..", "..", "..", "..")
const read = (relative: string) => {
  const raw = readFileSync(join(ROOT, relative), "utf8")
  expect(raw.length, `${relative} must be readable — a moved file must fail LOUDLY`).toBeGreaterThan(300)
  return raw
}

/** Parsed source, comments blanked. The file name is passed so the scanner parses it as TypeScript. */
const code = (relative: string) => stripComments(read(relative), relative)

const MIDDLEWARE = "packages/novaclaw/src/server/routes/instance/httpapi/middleware/cors-outcome-log.ts"
const SERVER = "packages/novaclaw/src/server/routes/instance/httpapi/server.ts"
const EVENTS = "packages/schema/src/log-events.ts"

/**
 * 🔴 A MENTION IN A COMMENT IS NOT A MOUNT — so this greps parsed source, not raw text.
 *
 * Caught here on 2026-09-29, failing on its own subject. The ordering case below indexes
 * `corsVaryFix` and `corsOutcomeLog` in the layer list, and the comment explaining WHY the order is
 * load-bearing mentions `corsVaryFix` one line above the entry. The comment won the index, and a
 * correct layer list read as misordered. A source-grep test that prose can defeat will be defeated
 * again, silently, on the change most likely to matter.
 *
 * ⚠️ `stripComments` is the house's AST-based, offset-preserving strip, shared as
 * `@novaclaw/core/test/source-scan`. The first draft of this file hand-rolled the obvious
 * two-regex version and was wrong in the dangerous direction: `source-scan.ts` records that a slash-
 * star inside a line comment or a string makes such a strip delete real code — 19 files of
 * `core/src` lost code that way and `session.ts` lost 650 lines, silently, in guards that assert an
 * empty offender list. A guard that has gone blind and a tree that is clean are the same
 * observation. There is one strip; this is it.
 */

describe("the CORS outcome log is mounted where it can see the answer", () => {
  /**
   * The ONE `Layer.provide([...])` that lists the HTTP middleware stack.
   *
   * ⚠️ Anchored on a sibling that is unique to that list, not on the first `Layer.provide([` — there
   * are seven of them in this file, and the one that matters is the one carrying `corsVaryFix`. A
   * test that matched the first would pass on an unrelated list, which is the class of test that
   * looks like coverage and is not.
   */
  const middlewareStack = () => {
    const server = code(SERVER)
    const at = server.indexOf("corsVaryFix", server.indexOf("Layer.provide(["))
    expect(at, "corsVaryFix must be listed in the middleware stack").toBeGreaterThan(-1)
    const start = server.lastIndexOf("Layer.provide([", at)
    const end = server.indexOf("])", at)
    return server.slice(start, end + 2)
  }

  test("it is in the layer list, not merely defined", () => {
    // A middleware that exists and is never mounted is the exact failure mode this whole file is
    // about — an observation nobody can reach. Mounted-ness is the claim worth pinning.
    expect(code(SERVER)).toContain('import { corsOutcomeLog } from "./middleware/cors-outcome-log"')
    expect(middlewareStack(), "the middleware stack must carry corsOutcomeLog").toContain("corsOutcomeLog")
  })

  test("🔴 it is listed BEFORE corsVaryFix and cors(), so it records the FINAL headers", () => {
    // Order is load-bearing and easy to get backwards. Listed after them it would see the response
    // before the Vary fix had run, and the allow-origin header it read would be the wrong one. A
    // diagnostic that reports the wrong answer is worse than none at all.
    const stack = middlewareStack()
    const at = (needle: string) => stack.indexOf(needle)
    expect(at("corsOutcomeLog")).toBeGreaterThan(-1)
    expect(at("corsVaryFix")).toBeGreaterThan(-1)
    expect(at("cors(corsOptions)")).toBeGreaterThan(-1)
    expect(at("corsOutcomeLog"), "must observe the response, so it must be listed first").toBeLessThan(
      at("corsVaryFix"),
    )
    expect(at("corsOutcomeLog"), "must observe the response, so it must be listed first").toBeLessThan(
      at("cors(corsOptions)"),
    )
  })
})

describe("the four outcomes are distinguishable", () => {
  const middleware = code(MIDDLEWARE)

  test("a preflight is recognised by METHOD, not by the presence of a cors header", () => {
    expect(middleware).toMatch(/request\.method !== "OPTIONS"/)
  })

  test("🔴 passthrough is separated from refused BY STATUS — the whole question", () => {
    // 2xx with an Origin and no allow-origin is the policy saying no. Anything else is CORS never
    // running, which is the shape the client reported. Collapsing them is what made the boot
    // unanswerable: both look like "no ACAO header" from the outside.
    expect(middleware).toMatch(/status >= 200 && status < 300 \? "refused" : "passthrough"/)
    expect(middleware).toContain('"server.cors.preflight.passthrough"')
    expect(middleware).toContain('"server.cors.preflight.refused"')
  })

  test("a missing Origin is its own outcome, not a silent pass", () => {
    // A preflight with no Origin is a different shape entirely, and treating it as "allowed" would
    // bury the case where something upstream stripped the header.
    expect(middleware).toContain('"server.cors.preflight.noorigin"')
  })

  test("the status is recorded on EVERY outcome, since it is the discriminator", () => {
    expect(middleware).toContain('"server.cors.status": status')
  })
})

describe("the events are declared, and the boring one is quiet", () => {
  const events = code(EVENTS)

  test.each([
    "server.cors.preflight.allowed",
    "server.cors.preflight.noorigin",
    "server.cors.preflight.refused",
    "server.cors.preflight.passthrough",
  ])("%s is declared in the log schema", (name) => {
    expect(events).toContain(`"${name}"`)
  })

  test("a preflight fires on every cross-origin fetch, so the ALLOWED case must be debug", () => {
    // The asymmetry is deliberate and load-bearing: `allowed` is the overwhelming majority, and at
    // `warn` it would drown the log file — which is how a real signal gets lost. The three unexpected
    // shapes are `warn`, because a preflight that did not get an allow-origin IS the event.
    const allowed = /"server\.cors\.preflight\.allowed":\s*\{[\s\S]*?level: "(\w+)"/.exec(events)?.[1]
    expect(allowed, "the allowed case must declare a level").toBeDefined()
    expect(allowed).toBe("debug")
    for (const name of ["noorigin", "refused", "passthrough"]) {
      const level = new RegExp(`"server\\.cors\\.preflight\\.${name}":\\s*\\{[\\s\\S]*?level: "(\\w+)"`).exec(
        events,
      )?.[1]
      expect(level, `${name} must declare a level`).toBeDefined()
      expect(level, `${name} must be warn — it is an unexpected shape`).toBe("warn")
    }
  })

  test("a refused or bypassed preflight is user-visible content, not internal", () => {
    // `content: "user"` is what puts the line in front of a person reading their own log. A boot that
    // cannot be explained is exactly when someone else is looking at it.
    for (const name of ["refused", "passthrough"]) {
      const block = new RegExp(`"server\\.cors\\.preflight\\.${name}":[\\s\\S]*?content: "(\\w+)"`).exec(events)?.[1]
      expect(block, `${name} must declare content`).toBeDefined()
      expect(block).toBe("user")
    }
  })
})
