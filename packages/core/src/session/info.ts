import { DateTime } from "effect"
import { Location } from "../location"
import { AbsolutePath, RelativePath } from "../schema"
import { SessionConfigColumns } from "./config-columns"
import { WorkspaceV2 } from "../workspace"
import { SessionSchema } from "./schema"
import { SessionTable } from "./sql"
import { SessionMessage } from "./message"
import { Snapshot } from "../snapshot"

export function fromRow(row: typeof SessionTable.$inferSelect): SessionSchema.Info {
  return SessionSchema.Info.make({
    id: SessionSchema.ID.make(row.id),
    slug: row.slug,
    version: row.version,
    metadata: row.metadata ?? undefined,
    title: row.title,
    parentID: row.parent_id ? SessionSchema.ID.make(row.parent_id) : undefined,
    // The per-session CONFIG fields (`model`, `agent`, the mode, the Tuning switches, …)
    // are generated from `SESSION_CONFIG_FIELDS` — one descriptor, so this direction and
    // `projector.ts`'s `sessionRow` cannot disagree about which columns exist. They disagreed for
    // four months (`sessionRow` dropped three of them); see `config-columns.ts`.
    ...SessionConfigColumns.configFromRow(row),
    providerRecovery: row.provider_recovery
      ? { ...row.provider_recovery, startedAt: DateTime.makeUnsafe(row.provider_recovery.startedAt) }
      : undefined,
    result: row.result ?? undefined,
    cost: row.cost,
    tokens: {
      input: row.tokens_input,
      output: row.tokens_output,
      reasoning: row.tokens_reasoning,
      cache: {
        read: row.tokens_cache_read,
        write: row.tokens_cache_write,
      },
    },
    location: Location.Ref.make({
      directory: AbsolutePath.make(row.directory),
      workspaceID: row.workspace_id ? WorkspaceV2.ID.make(row.workspace_id) : undefined,
    }),
    subpath: row.path ? RelativePath.make(row.path) : undefined,
    revert: row.revert ? { ...row.revert, messageID: SessionMessage.ID.make(row.revert.messageID) } : undefined,
    // The drain-end changes summary, row-faithful (V1-nuke slice A: natively surfaced — the V1
    // wire shape was the only carrier before).
    summary:
      row.summary_additions !== null || row.summary_deletions !== null || row.summary_files !== null
        ? {
            additions: row.summary_additions ?? 0,
            deletions: row.summary_deletions ?? 0,
            files: row.summary_files ?? 0,
            diffs: row.summary_diffs ?? undefined,
            from: row.summary_from ?? undefined,
            to: row.summary_to ?? undefined,
            complete: row.summary_complete ?? undefined,
          }
        : undefined,
    time: {
      created: DateTime.makeUnsafe(row.time_created),
      updated: DateTime.makeUnsafe(row.time_updated),
      archived: row.time_archived ? DateTime.makeUnsafe(row.time_archived) : undefined,
    },
  })
}
