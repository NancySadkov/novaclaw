import { afterEach, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@novaclaw/core/database/database"
import { SessionSchema } from "@novaclaw/core/session/schema"
import { SessionTable } from "@novaclaw/core/session/sql"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffectShared } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffectShared(Layer.mergeAll(Database.defaultLayer, httpApiLayer))

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

it.instance("session metadata omits patches and the changes endpoint preserves them", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const { db } = yield* Database.Service
    const id = SessionSchema.ID.make("ses_httpchanges")
    const diffs = [
      { file: "main.ts", patch: "@@ -1 +1 @@\n-" + "old".repeat(100000) + "\n+new\n", additions: 1, deletions: 1 },
    ]
    yield* db
      .insert(SessionTable)
      .values({
        id,
        slug: id,
        directory: test.directory,
        title: id,
        version: "test",
        summary_files: 1,
        summary_additions: 1,
        summary_deletions: 1,
        summary_diffs: diffs,
      })
      .run()
      .pipe(Effect.orDie)
    const metadata = yield* requestInDirectory(`/api/session/${id}`, test.directory)
    expect(metadata.status).toBe(200)
    const metadataBody = yield* metadata.text
    expect(JSON.parse(metadataBody)).toMatchObject({ data: { summary: { files: 1 } } })
    expect(metadataBody).not.toContain('"patch"')
    expect(metadataBody.length).toBeLessThan(2_000)
    const listed = yield* requestInDirectory("/api/session", test.directory)
    expect(yield* listed.text).not.toContain('"patch"')
    const changes = yield* requestInDirectory(`/api/session/${id}/diff`, test.directory)
    expect(changes.status).toBe(200)
    expect(yield* changes.json).toEqual({ data: diffs })
    const missing = yield* requestInDirectory("/api/session/ses_missing/diff", test.directory)
    expect(missing.status).toBe(404)
  }),
)
