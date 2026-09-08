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
import * as KbTool from "./deferred/kb.gen"
import * as DbRegistryTool from "./deferred/db-registry.gen"
import * as LogTool from "./deferred/log.gen"
import * as MessengerTool from "./deferred/messenger.gen"
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
import { SkillTool } from "./skill"
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
import { WaitTool } from "./wait"
import { WriteTool } from "./write"
import * as WriteHexTool from "./deferred/write-hex.gen"
import { UpgradeChatTool } from "./upgrade-chat"

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
    KbTool.node,
    LogTool.node,
    DbRegistryTool.node,
    MessengerTool.node,
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
    SkillTool.node,
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
    UpgradeChatTool.node,
  ],
})
