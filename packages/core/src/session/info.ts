import { DateTime } from "effect"
import { AgentV2 } from "../agent"
import { Location } from "../location"
import { ModelV2 } from "../model"
import { ProjectV2 } from "../project"
import { ProviderV2 } from "../provider"
import { AbsolutePath, RelativePath } from "../schema"
import { WorkspaceV2 } from "../workspace"
import { SessionSchema } from "./schema"
import { SessionTable } from "./sql"
import { SessionMessage } from "./message"
import { Snapshot } from "../snapshot"
import { SessionV1 } from "../v1/session"

export function fromRow(row: typeof SessionTable.$inferSelect): SessionSchema.Info {
  return SessionSchema.Info.make({
    id: SessionSchema.ID.make(row.id),
    projectID: ProjectV2.ID.make(row.project_id),
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
    time: {
      created: DateTime.makeUnsafe(row.time_created),
      updated: DateTime.makeUnsafe(row.time_updated),
      archived: row.time_archived ? DateTime.makeUnsafe(row.time_archived) : undefined,
    },
  })
}

/**
 * Map a session row to the LEGACY `SessionV1.SessionInfo` shape — the payload of the
 * session-level V1 events (`session.created/updated/deleted`) that the V2 engine keeps
 * emitting (F1g retires only the message/part half of the V1 schema). Mirrors the V1
 * engine's own `fromRow` so a full-info `Updated` publish round-trips the row through the
 * projector's `sessionRow` write without drift. V1-parity caveat: the V1 revert shape
 * carries no `files`, so projecting a full-info update drops a staged revert's file list.
 */
export function v1InfoFromRow(row: typeof SessionTable.$inferSelect): SessionV1.SessionInfo {
  const summary =
    row.summary_additions !== null || row.summary_deletions !== null || row.summary_files !== null
      ? {
          additions: row.summary_additions ?? 0,
          deletions: row.summary_deletions ?? 0,
          files: row.summary_files ?? 0,
          diffs: row.summary_diffs ?? undefined,
        }
      : undefined
  return SessionV1.SessionInfo.make({
    id: row.id,
    slug: row.slug,
    projectID: row.project_id,
    workspaceID: row.workspace_id ?? undefined,
    directory: row.directory,
    path: row.path ?? undefined,
    parentID: row.parent_id ?? undefined,
    title: row.title,
    agent: row.agent ?? undefined,
    model: row.model
      ? {
          id: ModelV2.ID.make(row.model.id),
          providerID: ProviderV2.ID.make(row.model.providerID),
          variant: row.model.variant,
        }
      : undefined,
    systemPromptOverride: row.system_prompt_override ?? undefined,
    type: row.type ?? undefined,
    priority: row.priority ?? undefined,
    responder: row.responder ?? undefined,
    permissionMode: row.permission_mode ?? undefined,
    result: row.result ?? undefined,
    version: row.version,
    summary,
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
    share: row.share_url ? { url: row.share_url } : undefined,
    metadata: row.metadata ?? undefined,
    revert: row.revert
      ? {
          messageID: SessionV1.MessageID.make(row.revert.messageID),
          partID: row.revert.partID ? SessionV1.PartID.make(row.revert.partID) : undefined,
          snapshot: row.revert.snapshot,
          diff: row.revert.diff,
        }
      : undefined,
    permission: row.permission ? [...row.permission] : undefined,
    time: {
      created: row.time_created,
      updated: row.time_updated,
      compacting: row.time_compacting ?? undefined,
      archived: row.time_archived ?? undefined,
    },
  })
}
