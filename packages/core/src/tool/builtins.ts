export * as BuiltInTools from "./builtins"

import { makeLocationNode } from "../effect/app-node"
import { Layer } from "effect"
import { BashTool } from "./bash"
import { ApplyPatchTool } from "./apply-patch"
import * as ConfigureTool from "./deferred/configure.gen"
import { DefineToolTool } from "./define-tool"
import { DocsTool } from "./docs"
import { EditTool } from "./edit"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import { JsTool } from "./js"
import * as DbRegistryTool from "./deferred/db-registry.gen"
import * as LogTool from "./deferred/log.gen"
import * as MessengerTool from "./deferred/messenger.gen"
import * as NudgeTool from "./deferred/nudge.gen"
import * as ScheduleTool from "./deferred/schedule.gen"
import * as PermissionTool from "./deferred/permission.gen"
import * as ProfileTool from "./deferred/profile.gen"
import { SelfTool } from "./self"
import * as QualityProvisionTool from "./deferred/quality-provision.gen"
import { ReadTool } from "./read"
import * as SessionTool from "./deferred/session.gen"
import * as ResourceStatusTool from "./deferred/resource-status.gen"
import * as ReadHexTool from "./deferred/read-hex.gen"
import * as RecipeTool from "./deferred/recipe.gen"
import * as RegisterAppTool from "./deferred/register-app.gen"
import * as RevertTool from "./deferred/revert.gen"
import { TodoWriteTool } from "./todowrite"
import { ToolManualTool } from "./tool-manual"
import { ToolCallTool } from "./tool-call"
import { ToolSearchTool } from "./tool-search"
import * as TrashTool from "./deferred/trash.gen"
import * as ComputerTool from "./deferred/computer.gen"
import { WebFetchTool } from "./webfetch"
import { WebSearchTool } from "./websearch"
import { ColleagueTool } from "./colleague"
import { SpawnTool } from "./spawn"
import * as CommunityTool from "./deferred/community.gen"
import { ExitTool } from "./exit"
// The memo tools are RESIDENT (owner, 2026-09-17: "part of the basic tools list, like edit and spawn"),
// so their real modules are imported here rather than a generated schema-only stand-in. A deferred
// registration is what keeps the worker graph from importing an implementation, and residency is the
// deliberate opposite of that: the prompt names `memo_set` / `memo_clear`, so reaching them must not
// cost a `tool_search` round trip.
import { MemoClearTool } from "./memo-clear"
import { MemoSetTool } from "./memo-set"
import { WaitTool } from "./wait"
import { KillTool } from "./kill"
import { WriteTool } from "./write"
import * as WriteHexTool from "./deferred/write-hex.gen"

export const node = makeLocationNode({
  name: "built-in-tools",
  layer: Layer.empty,
  deps: [
    ApplyPatchTool.node,
    BashTool.node,
    ConfigureTool.node,
    DefineToolTool.node,
    DocsTool.node,
    EditTool.node,
    GlobTool.node,
    GrepTool.node,
    JsTool.node,
    LogTool.node,
    DbRegistryTool.node,
    MemoClearTool.node,
    MemoSetTool.node,
    MessengerTool.node,
    NudgeTool.node,
    ScheduleTool.node,
    PermissionTool.node,
    ProfileTool.node,
    QualityProvisionTool.node,
    ReadTool.node,
    ReadHexTool.node,
    RecipeTool.node,
    SelfTool.node,
    SessionTool.node,
    ResourceStatusTool.node,
    RegisterAppTool.node,
    RevertTool.node,
    TodoWriteTool.node,
    ToolManualTool.node,
    ToolCallTool.node,
    ToolSearchTool.node,
    TrashTool.node,
    ComputerTool.node,
    WebFetchTool.node,
    WebSearchTool.node,
    WriteTool.node,
    WriteHexTool.node,
    ColleagueTool.node,
    SpawnTool.node,
    CommunityTool.node,
    ExitTool.node,
    WaitTool.node,
    KillTool.node,
  ],
})
