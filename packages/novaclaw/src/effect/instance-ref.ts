import { Context } from "effect"
import type { InstanceContext } from "@/project/instance-context"
import type { WorkspaceV2 } from "@novaclaw/core/workspace"

export const InstanceRef = Context.Reference<InstanceContext | undefined>("~novaclaw/InstanceRef", {
  defaultValue: () => undefined,
})

export const WorkspaceRef = Context.Reference<WorkspaceV2.ID | undefined>("~novaclaw/WorkspaceRef", {
  defaultValue: () => undefined,
})
