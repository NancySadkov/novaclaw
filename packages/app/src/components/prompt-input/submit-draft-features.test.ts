// THE DRAFT HALF of "a new-session draft must not silently discard its per-chat switches".
//
// The composer's Tuning panel writes a draft's stances into `local.features` — a chat that does not
// exist yet — and `submit.ts` is the only thing that turns them into a `session.create` body. Until
// 2026-07-31 it spread three of the seven by hand, so *Safe mode*, *Ask before changes* and
// *Surgical edits* — three RESTRICTIONS, i.e. switches that NARROW what the agent may do — were
// accepted by the UI and dropped on the floor, with no post-create catch-up to rescue them
// (`session-composer-controls.ts` calls `switchFeature` only when a session `id` already exists).
// A user who ticks "ask before changes" and watches the agent change files anyway has been lied to,
// which is ruling 2 (*a failed mutation never reports success*).
//
// The wire half of the same defect — the payload schema and the server handler — is pinned by
// `packages/server/src/handlers/session-create-features.test.ts`, which drives a real request
// through a real kernel. This file covers what that one cannot see: the browser's mapping.
//
// ⚠️ It is a RATCHET. The switch list is read out of `packages/schema/src/session-feature.ts` — the
// kernel's own union, by source — rather than repeated here, so an eighth feature fails this file
// by name until `submit.ts` carries it. Reading a sibling package's source is the same technique
// `packages/core/test/session-safe-mode.test.ts` §B uses, and for the same reason: `packages/app`
// deliberately does not depend on `@novaclaw/schema`, but the contract between them is still real.

import { beforeAll, describe, expect, mock, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

// `submit.ts` is a browser module: importing it pulls `@solidjs/router`, which throws at import
// time under the unit tier (no `--conditions=browser`, so solid resolves its SERVER build). The
// mock is the same shape `submit.test.ts` in this directory already installs process-wide, so it
// adds no surface that was not already replaced — and nothing here touches routing.
let newSessionCreateBody: typeof import("./submit").newSessionCreateBody
let DRAFT_FEATURE_NAMES: typeof import("./submit").DRAFT_FEATURE_NAMES

beforeAll(async () => {
  mock.module("@solidjs/router", () => ({
    useNavigate: () => () => undefined,
    useParams: () => ({}),
    useLocation: () => ({}),
    useSearchParams: () => [{}, () => undefined],
  }))
  const mod = await import("./submit")
  newSessionCreateBody = mod.newSessionCreateBody
  DRAFT_FEATURE_NAMES = mod.DRAFT_FEATURE_NAMES
})

const PACKAGES = path.join(import.meta.dir, "..", "..", "..", "..")
const FEATURE_SCHEMA = path.join(PACKAGES, "schema", "src", "session-feature.ts")
const SUBMIT = path.join(import.meta.dir, "submit.ts")

const read = (file: string) => {
  const text = fs.readFileSync(file, "utf8")
  // Guards the failure mode this whole technique is exposed to: a moved file would make every
  // comparison below trivially empty and every assertion pass while proving nothing.
  expect(text.length, `${file} is empty or missing — has it moved?`).toBeGreaterThan(200)
  return text
}

/** The kernel's per-session feature names, read off `SessionFeature.Name`'s own literal list. */
const kernelFeatures = (): string[] => {
  const source = read(FEATURE_SCHEMA)
  const block = /export const Name = Schema\.Literals\(\[([\s\S]*?)\]\)/.exec(source)
  expect(block, "SessionFeature.Name is not where this test expects it in schema/src/session-feature.ts").not.toBeNull()
  return [...block![1]!.matchAll(/"([A-Za-z]+)"/g)].map((match) => match[1]!)
}

const base = { permissionMode: "ask", strict: undefined, mode: undefined } as const

describe("a draft's Tuning switches reach session.create", () => {
  // The premise. If the list here ever falls behind the kernel's, every case below would still pass
  // while quietly testing a subset — which is exactly how three restrictions shipped broken.
  test("every kernel feature is a draft feature, and vice versa", () => {
    // `.map(String)` on the narrow side, not a cast on the wide one: `kernelFeatures()` is `string[]`
    // and `DRAFT_FEATURE_NAMES` is the literal union, and `toEqual` will not take the two at
    // different widths. Widening the known side is honest; asserting the kernel's list into the
    // union would claim the very fact this test exists to check.
    expect(
      [...DRAFT_FEATURE_NAMES].map(String).sort(),
      "submit.ts's switch list has drifted from SessionFeature.Name",
    ).toEqual(kernelFeatures().sort())
  })

  test("every switch the user set travels", () => {
    const features = Object.fromEntries(DRAFT_FEATURE_NAMES.map((name) => [name, true]))
    const body = newSessionCreateBody({ ...base, features }) as Record<string, unknown>
    const lost = DRAFT_FEATURE_NAMES.filter((name) => body[name] !== true)
    expect(
      lost.join(", "),
      "these switches were set on the draft and are missing from the create body — the composer accepted a stance the new chat will never have",
    ).toBe("")
  })

  // ⚠️ THE DIRECTION THAT WOULD BE WORSE THAN THE BUG. These are tri-states: an absent key means
  // INHERIT (the parent chain, then the global config block) — the ECS sparse-override discipline,
  // where only a divergent value creates a row value. A mapping written `safeMode: features?.safeMode
  // ?? false` would pass the case above and stamp a stance into every new session; for the three
  // narrowing switches that hands a fork of a restricted parent LESS restriction than its source,
  // which ruling 8 calls a defect rather than a preference.
  test("a switch the user never touched is ABSENT, not false", () => {
    for (const features of [undefined, {}, { quality: true }]) {
      const body = newSessionCreateBody({ ...base, features }) as Record<string, unknown>
      const invented = DRAFT_FEATURE_NAMES.filter((name) => !(name in (features ?? {})) && Object.hasOwn(body, name))
      expect(
        invented.join(", "),
        `with features=${JSON.stringify(features)} the body INVENTED a stance — that defeats inheritance and stamps a default into every new chat`,
      ).toBe("")
    }
  })

  // The other half of the tri-state: an explicit OFF is a stance too, and a truthiness-shaped
  // mapping (`if (value) …`) would silently drop it back to inherit.
  test("an explicit OFF travels as false", () => {
    const features = Object.fromEntries(DRAFT_FEATURE_NAMES.map((name) => [name, false]))
    const body = newSessionCreateBody({ ...base, features }) as Record<string, unknown>
    const lost = DRAFT_FEATURE_NAMES.filter((name) => body[name] !== false)
    expect(lost.join(", "), "an explicit OFF was dropped back to inherit — the user's stance was lost").toBe("")
  })

  // The rest of the draft is unchanged by the feature work, and is asserted so a refactor of the
  // mapping cannot quietly take the Mode or Strict choice with it.
  test("the non-feature draft choices still map as before", () => {
    expect(newSessionCreateBody({ ...base, features: undefined })).toEqual({})
    expect(
      newSessionCreateBody({ permissionMode: "plan", strict: undefined, features: undefined, mode: undefined }),
    ).toEqual({ permissionMode: "plan" })
    expect(
      newSessionCreateBody({
        permissionMode: "ask",
        strict: { enabled: true, attempts: 3 },
        features: undefined,
        mode: "goal-oriented",
      }),
    ).toEqual({ strict: { enabled: true, attempts: 3 }, type: "goal-oriented" })
    // "interactive" is the server default, so it is deliberately NOT sent.
    expect(
      newSessionCreateBody({ permissionMode: "ask", strict: undefined, features: undefined, mode: "interactive" }),
    ).toEqual({})
  })

  // A correct mapper that nothing calls is the same bug with better manners. `newSessionCreateBody`
  // is exported only so it can be tested, so the one call site is checked by name.
  test("the new-session create call actually uses the mapper", () => {
    const source = read(SUBMIT)
    expect(
      /\.create\(\s*\n?\s*newSessionCreateBody\(/.test(source),
      "submit.ts no longer builds the session.create body with newSessionCreateBody — the mapping under test is not the one that ships",
    ).toBe(true)
  })
})
