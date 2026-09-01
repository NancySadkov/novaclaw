export * as BuiltInTools from "./builtins"

import { makeLocationNode } from "../effect/app-node"
import { Layer } from "effect"
import { BashTool } from "./bash"
import { ApplyPatchTool } from "./apply-patch"
import { ConfigureTool } from "./configure"
import { DefineToolTool } from "./define-tool"
import { DocsTool } from "./docs"
import { EditTool } from "./edit"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import { JsTool } from "./js"
import { KbTool } from "./kb"
import { DbRegistryTool } from "./db-registry"
import { LogTool } from "./log"
import { MessengerTool } from "./messenger"
import { PermissionTool } from "./permission"
import { ProfileTool } from "./profile"
import { SelfTool } from "./self"
import { QualityProvisionTool } from "./quality-provision"
import { ReadTool } from "./read"
import { SessionTool } from "./session"
import { ResourceStatusTool } from "./resource-status"
import { ReadHexTool } from "./read-hex"
import { RecipeTool } from "./recipe"
import { RegisterAppTool } from "./register-app"
import { RevertTool } from "./revert"
import { SkillTool } from "./skill"
import { TodoWriteTool } from "./todowrite"
import { ToolManualTool } from "./tool-manual"
import { ToolCallTool } from "./tool-call"
import { ToolSearchTool } from "./tool-search"
import { TrashTool } from "./trash"
import { ComputerTool } from "./computer"
import { WebFetchTool } from "./webfetch"
import { WebSearchTool } from "./websearch"
import { ColleagueTool } from "./colleague"
import { SpawnTool } from "./spawn"
import { CommunityTool } from "./community"
import { ExitTool } from "./exit"
import { WaitTool } from "./wait"
import { WriteTool } from "./write"
import { WriteHexTool } from "./write-hex"
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
