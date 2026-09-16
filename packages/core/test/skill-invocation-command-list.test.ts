import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { CommandList } from "@novaclaw/core/command/list"
import { ExternalCommandSource } from "@novaclaw/core/command/external-command-source"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { Location } from "@novaclaw/core/location"
import { LocationServiceMap } from "@novaclaw/core/location-services"
import { AbsolutePath } from "@novaclaw/core/schema"
import { SkillV2 } from "@novaclaw/core/skill"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { Database } from "../src/database/database"
import { EventV2 } from "../src/event"
import { SettingsConfigStore } from "../src/settings-config-store"

// "Show it for me to run", driven against the REAL wiring rather than a stub.
//
// ⚠️ **The layer is `LocationServiceMap.Service.get(location)` on purpose.** `CommandList.list` grew
// a `Config.Service` read for this feature, and a service a route handler cannot resolve fails at
// RUNTIME with "Service not found" while the typechecker stays green — the fault that cost two
// agents a day. This is the exact layer both consumers provide (`packages/server/src/location.ts`'s
// `LocationMiddleware`, and `novaclaw`'s instance handler, which pipes `locations.get(...)` in by
// hand), and `location-services.ts` lists `Config.node` in the same LOCATION_NODES group as
// `CommandV2.node`, `SkillV2.node` and `ExternalCommandSource.node`. If that ever stops being true,
// this test is what says so.
//
// ⚠️ And the store is the REAL `SettingsConfigStore`, written through `set("skill_invocation", …)`,
// because the thing under test is a settings key reaching a reader — not a record literal being
// filtered. A key that is not in `SETTINGS_KEYS` decodes away here.

/** An MCP prompt that collides with a skill by name — the `seen` ledger's whole reason to exist. */
const externalPrompt = (name: string) =>
  Layer.succeed(
    ExternalCommandSource.Service,
    ExternalCommandSource.Service.of({
      entries: () =>
        Effect.succeed(
          new Map([
            [
              name,
              // `template` is an Effect on this seam — an MCP prompt is fetched from its server at
              // dispatch — and `CommandList` lists it as "" without forcing it.
              { description: "an MCP prompt of the same name", template: Effect.succeed(""), hints: [] as string[] },
            ],
          ]),
        ),
    }),
  )

const build = (external?: Layer.Layer<ExternalCommandSource.Service>) =>
  testEffect(
    AppNodeBuilder.build(
      LayerNode.group([Database.node, EventV2.node, SettingsConfigStore.node, LocationServiceMap.node]),
      external ? [[ExternalCommandSource.node, external]] : [],
    ),
  )

const writeSkill = async (directory: string, name: string) => {
  await fs.mkdir(path.join(directory, name), { recursive: true })
  await fs.writeFile(
    path.join(directory, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} does things\n---\n# ${name}`,
  )
}

const withFixture = <A, E, R>(body: (input: { location: Location.Ref; skills: string }) => Effect.Effect<A, E, R>) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
  ).pipe(
    Effect.flatMap((dir) =>
      Effect.promise(async () => {
        const skills = path.join(dir.path, "skills")
        await writeSkill(skills, "shown-skill")
        await writeSkill(skills, "hidden-skill")
        return skills
      }).pipe(
        Effect.flatMap((skills) =>
          body({ location: Location.Ref.make({ directory: AbsolutePath.make(dir.path) }), skills }),
        ),
      ),
    ),
  )

/** Register the fixture directory and return the slash-command names the list serves. */
const names = (skills: string) =>
  Effect.gen(function* () {
    const skill = yield* SkillV2.Service
    yield* skill.transform((editor) => editor.source({ type: "directory", path: AbsolutePath.make(skills) }))
    return (yield* CommandList.list).map((entry) => `${entry.source}:${entry.name}`)
  })

describe("CommandList honours the user's 'Show it for me to run' choice", () => {
  const it = build()

  it.live("both skills are listed until the user says otherwise — ON is the default", () =>
    Effect.scoped(
      withFixture(({ location, skills }) =>
        Effect.gen(function* () {
          const listed = yield* names(skills)
          expect(listed).toContain("skill:shown-skill")
          expect(listed).toContain("skill:hidden-skill")
        }).pipe(Effect.provide(LocationServiceMap.Service.get(location))),
      ),
    ),
  )

  it.live("a saved show:false removes exactly that skill and nothing else", () =>
    Effect.scoped(
      withFixture(({ location, skills }) =>
        Effect.gen(function* () {
          const store = yield* SettingsConfigStore.Service
          yield* store.set("skill_invocation", { "hidden-skill": { show: false } })

          const listed = yield* names(skills).pipe(Effect.provide(LocationServiceMap.Service.get(location)))
          expect(listed).toContain("skill:shown-skill")
          expect(listed).not.toContain("skill:hidden-skill")
          // The built-in commands are untouched — this gate reads `source === "skill"` only.
          expect(listed.some((entry) => entry.startsWith("command:"))).toBe(true)
        }),
      ),
    ),
  )

  it.live("clearing the choice brings it back — the write is reversible through the same store", () =>
    Effect.scoped(
      withFixture(({ location, skills }) =>
        Effect.gen(function* () {
          const store = yield* SettingsConfigStore.Service
          yield* store.set("skill_invocation", { "hidden-skill": { show: false } })
          expect(yield* names(skills).pipe(Effect.provide(LocationServiceMap.Service.get(location)))).not.toContain(
            "skill:hidden-skill",
          )

          yield* store.set("skill_invocation", {})
          expect(yield* names(skills).pipe(Effect.provide(LocationServiceMap.Service.get(location)))).toContain(
            "skill:hidden-skill",
          )
        }),
      ),
    ),
  )

  it.live("the choice is read THROUGH on every call — no restart, no reload domain", () =>
    Effect.scoped(
      withFixture(({ location, skills }) =>
        Effect.gen(function* () {
          const store = yield* SettingsConfigStore.Service
          // One location layer, resolved once: re-providing it between the two reads would pass even
          // if the value were frozen at construction (the ruling-3 shape `config-read-through` pins).
          yield* Effect.gen(function* () {
            expect(yield* names(skills)).toContain("skill:hidden-skill")
            yield* store.set("skill_invocation", { "hidden-skill": { show: false } })
            expect(yield* CommandList.list.pipe(Effect.map((list) => list.map((entry) => entry.name)))).not.toContain(
              "hidden-skill",
            )
          }).pipe(Effect.provide(LocationServiceMap.Service.get(location)))
        }),
      ),
    ),
  )
})

describe("hiding a skill must not delete the thing standing behind it", () => {
  // `seen` is the collision ledger: CommandV2 > skill > MCP. A hidden skill that still marked its
  // name as seen would suppress the MCP prompt underneath, so one user choice would silently remove
  // a DIFFERENT entry. The naive `if (hidden) { seen.add(name); continue }` fails exactly here.
  const it = build(externalPrompt("hidden-skill"))

  it.live("an MCP prompt with the same name surfaces once the skill is hidden", () =>
    Effect.scoped(
      withFixture(({ location, skills }) =>
        Effect.gen(function* () {
          const store = yield* SettingsConfigStore.Service

          const before = yield* names(skills).pipe(Effect.provide(LocationServiceMap.Service.get(location)))
          expect(before).toContain("skill:hidden-skill")
          expect(before).not.toContain("mcp:hidden-skill")

          yield* store.set("skill_invocation", { "hidden-skill": { show: false } })

          const after = yield* names(skills).pipe(Effect.provide(LocationServiceMap.Service.get(location)))
          expect(after).not.toContain("skill:hidden-skill")
          expect(after).toContain("mcp:hidden-skill")
        }),
      ),
    ),
  )
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The PROJECT layer — `novaclaw.json`'s `skills` section, driven through the real wiring.
//
// 🔴 **A project may HIDE a skill, never UN-HIDE one the instance hid.** A `novaclaw.json` travels
// inside a repository the user cloned, so it is untrusted input — the same reason `evaluateNarrowed`
// refuses to let one widen a permission and `narrowTune` refuses to let one lower a safety rail. The
// enforcement is `ProjectFile.narrowSkills` at the `ProjectFileCache` boundary, and this file is
// where it is exercised end to end rather than as a pure function.
//
// ⚠️ The file is written BEFORE the first read of that directory, always. `ProjectFileCache` holds a
// folder for a 1 s freshness bound, so a test that read first and wrote after would be racing its
// own TTL — passing or failing on timing rather than on the rule.
//
// ⚠️ The location layer is `LocationServiceMap.Service.get(location)` for the reason this file's
// header already records: `CommandList.list` now also reads `Location.Service` and
// `ProjectFileCache.Service`, and a service a route handler cannot resolve fails at RUNTIME while
// the typechecker stays green. `ProjectFileCache.node` was a DEPENDENCY of the location graph and
// not a member of it, which is exactly that fault — this describe is what says so.

const writeProject = (directory: string, value: unknown) =>
  fs.writeFile(path.join(directory, "novaclaw.json"), `${JSON.stringify(value, null, 2)}\n`)

/** The fixture above, plus a `novaclaw.json` in the location directory written before any read. */
const withProject = <A, E, R>(
  file: unknown,
  body: (input: { location: Location.Ref; skills: string; directory: string }) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
  ).pipe(
    Effect.flatMap((dir) =>
      Effect.promise(async () => {
        const skills = path.join(dir.path, "skills")
        await writeSkill(skills, "shown-skill")
        await writeSkill(skills, "hidden-skill")
        if (file !== undefined) await writeProject(dir.path, file)
        return skills
      }).pipe(
        Effect.flatMap((skills) =>
          body({
            location: Location.Ref.make({ directory: AbsolutePath.make(dir.path) }),
            skills,
            directory: dir.path,
          }),
        ),
      ),
    ),
  )

// 🗑️ `describe("a folder's novaclaw.json may hide a skill from the user's own slash menu")` stood here. Its subject was the folder's `novaclaw.json`, retired
// 2026-09-16 (owner: *"Please ensure it is gone for good."*). The cases are deleted rather than
// re-pinned because every one of them asserts a behaviour that no longer exists: the mechanism they
// measured was removed, not changed. The programme and the cost are in `todo/retire-project-file.md`
// (plan repo); the surviving halves — the instance `skill_invocation` store, the always-on policy
// providers, the plain `AGENTS.md` walk — are covered by the other suites in this file.
