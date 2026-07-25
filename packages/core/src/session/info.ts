import { DateTime } from "effect"
import { AgentV2 } from "../agent"
import { Location } from "../location"
import { ModelV2 } from "../model"
import { ProviderV2 } from "../provider"
import { AbsolutePath, RelativePath } from "../schema"
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
    permission: row.permission ?? undefined,
    metadata: row.metadata ?? undefined,
    title: row.title,
    parentID: row.parent_id ? SessionSchema.ID.make(row.parent_id) : undefined,
    agent: row.agent ? AgentV2.ID.make(row.agent) : undefined,
    model: row.model
      ? {
          id: ModelV2.ID.make(row.model.id),
          providerID: ProviderV2.ID.make(row.model.providerID),
          variant: ModelV2.VariantID.make(row.model.variant ?? "default"),
        }
      : undefined,
    systemPromptOverride: row.system_prompt_override ?? undefined,
    type: row.type ?? undefined,
    priority: row.priority ?? undefined,
    responder: row.responder ?? undefined,
    permissionMode: row.permission_mode ?? undefined,
    strict: row.strict ?? undefined,
    introspection: row.introspection ?? undefined,
    quality: row.quality ?? undefined,
    affective: row.affective ?? undefined,
    thinkingBudget: row.thinking_budget ?? undefined,
    surgicalEdits: row.surgical_edits ?? undefined,
    askBeforeChanges: row.ask_before_changes ?? undefined,
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
          }
        : undefined,
    time: {
      created: DateTime.makeUnsafe(row.time_created),
      updated: DateTime.makeUnsafe(row.time_updated),
      archived: row.time_archived ? DateTime.makeUnsafe(row.time_archived) : undefined,
    },
  })
}
