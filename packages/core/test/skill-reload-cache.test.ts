import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { AbsolutePath } from "@novaclaw/core/schema"
import { SkillV2 } from "@novaclaw/core/skill"
import { SkillDiscovery } from "@novaclaw/core/skill/discovery"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

// Directory sources only — discovery is the URL leg and must never be reached here.
const discovery = Layer.succeed(
  SkillDiscovery.Service,
  SkillDiscovery.Service.of({ pull: () => Effect.die("SkillDiscovery.pull is not part of this test") }),
)

const it = testEffect(AppNodeBuilder.build(SkillV2.node, [[SkillDiscovery.node, discovery]]))

const write = async (directory: string, name: string, description: string) => {
  await fs.mkdir(path.join(directory, name), { recursive: true })
  await fs.writeFile(
    path.join(directory, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}`,
  )
}

const withSkills = <A, E, R>(body: (skills: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => body(path.join(tmp.path, "skills")),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

const described = (skills: ReadonlyArray<SkillV2.Info>) =>
  skills.map((skill) => `${skill.name}:${skill.description}`).toSorted()

describe("SkillV2 cache invalidation", () => {
  // The regression: `list` memoized per Source.key with no invalidation path anywhere, so a skill
  // an agent had just authored stayed invisible for the whole process lifetime.
  it.live("reload re-reads a directory an agent wrote into, while list() still caches within a generation", () =>
    withSkills((skills) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => write(skills, "review", "Review a change"))
        const skill = yield* SkillV2.Service
        yield* skill.transform((editor) => editor.source({ type: "directory", path: AbsolutePath.make(skills) }))

        expect(described(yield* skill.list())).toEqual(["review:Review a change"])

        // What an agent maintaining its own instance does: author a new skill, amend an existing one.
        yield* Effect.promise(async () => {
          await write(skills, "deploy", "Ship the build")
          await write(skills, "review", "Review a change, carefully")
        })

        // Still served from the cache — the laziness in skill/guidance.ts depends on this, so the
        // fix must add invalidation without removing the caching.
        expect(described(yield* skill.list())).toEqual(["review:Review a change"])

        yield* skill.reload()

        expect(described(yield* skill.list())).toEqual(["deploy:Ship the build", "review:Review a change, carefully"])
      }),
    ),
  )

  // The second half of the same defect: the cache key is Source.key, so a source removed and
  // re-added at the same key used to resurrect the content the FIRST registration had read.
  it.live("a source re-registered at the same key is re-read, not resurrected from the previous one", () =>
    withSkills((skills) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => write(skills, "alpha", "Version one"))
        const skill = yield* SkillV2.Service
        const source: SkillV2.Source = { type: "directory", path: AbsolutePath.make(skills) }

        const registration = yield* skill.transform((editor) => editor.source(source))
        expect(described(yield* skill.list())).toEqual(["alpha:Version one"])

        yield* registration.dispose
        expect(yield* skill.list()).toEqual([])

        yield* Effect.promise(() => write(skills, "alpha", "Version two"))
        yield* skill.transform((editor) => editor.source(source))

        expect(described(yield* skill.list())).toEqual(["alpha:Version two"])
      }),
    ),
  )
})
