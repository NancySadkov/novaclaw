// Shared V2->V1 permission projection (F0). Two consumers MUST agree on this mapping or the
// client sees different shapes live vs after a reload:
//   1. the event bridge projects a live `permission.v2.asked` into the legacy
//      "permission.asked" vocabulary (event-v2-bridge.ts);
//   2. the GET /permission bootstrap list appends PENDING V2 asks so a reload mid-ask
//      re-renders the dock (handlers/permission.ts).
// Field mapping: action->permission, resources->patterns, save->always, source->tool.
import { PermissionV1 } from "@novaclaw/core/v1/permission"

export interface V2RequestLike {
  readonly id: string
  readonly sessionID: string
  readonly action: string
  readonly resources: readonly string[]
  readonly save?: readonly string[]
  readonly metadata?: Record<string, unknown>
  readonly source?: { readonly type: "tool"; readonly messageID: string; readonly callID: string }
}

export function toV1Request(request: V2RequestLike): PermissionV1.Request {
  return {
    id: request.id,
    sessionID: request.sessionID,
    permission: request.action,
    patterns: request.resources,
    metadata: request.metadata ?? {},
    always: request.save ?? [],
    tool: request.source ? { messageID: request.source.messageID, callID: request.source.callID } : undefined,
  } as unknown as PermissionV1.Request
}

export * as PermissionV2Project from "./v2-project"
