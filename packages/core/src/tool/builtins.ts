export * as BuiltInTools from "./builtins"

import { makeLocationNode } from "../effect/app-node"
import { Layer } from "effect"
import { BashTool } from "./bash"
import { BashJobs } from "./bash-jobs"
import { ApplyPatchTool } from "./apply-patch"
import { DefineToolTool } from "./define-tool"
import { EditTool } from "./edit"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import { JsTool } from "./js"
import { KbTool } from "./kb"
import { MessengerTool } from "./messenger"
import { ProfileTool } from "./profile"
import { QualityProvisionTool } from "./quality-provision"
import { QuestionTool } from "./question"
import { ReadTool } from "./read"
import { ReconfigureTool } from "./reconfigure"
import { ReadHexTool } from "./read-hex"
import { ReadToolFileSystem } from "./read-filesystem"
import { RegisterAppTool } from "./register-app"
import { RevertTool } from "./revert"
import { SkillTool } from "./skill"
import { TodoWriteTool } from "./todowrite"
import { ToolManualTool } from "./tool-manual"
import { TrashTool } from "./trash"
import { WebFetchTool } from "./webfetch"
import { WebSearchTool } from "./websearch"
import { SpawnTool } from "./spawn"
import { ExitTool } from "./exit"
import { WaitTool } from "./wait"
import { WriteTool } from "./write"
import { WriteHexTool } from "./write-hex"

/**
 * Composes only the shipped Location-scoped built-in tool transforms.
 * Each tool retains its implementation and focused tests independently. Dynamic
 * MCP and plugin tools later use separate scoped canonical registrations, while
 * provider/model filtering belongs to a future materialization phase rather
 * than this static list. The caller intentionally supplies shared Location
 * services once to this merged set.
 *
 * TODO: Port the remaining launch-follow-up leaves deliberately: edit fuzzy
 * parity, task,
 * repo_clone, repo_overview, plan_exit, and Rune/code mode. Keep MCP and plugin
 * transforms separate from this static built-in list.
 */
export const locationLayer = Layer.mergeAll(
  ApplyPatchTool.layer,
  BashTool.layer.pipe(Layer.provide(BashJobs.layer)),
  DefineToolTool.layer,
  EditTool.layer,
  GlobTool.layer,
  GrepTool.layer,
  JsTool.layer,
  KbTool.layer,
  MessengerTool.layer,
  ProfileTool.layer,
  QualityProvisionTool.layer,
  QuestionTool.layer,
  ReadTool.layer.pipe(Layer.provide(ReadToolFileSystem.layer)),
  ReadHexTool.layer,
  ReconfigureTool.layer,
  RegisterAppTool.layer,
  RevertTool.layer,
  SkillTool.layer,
  TodoWriteTool.layer,
  ToolManualTool.layer,
  TrashTool.layer,
  WebFetchTool.layer,
  WebSearchTool.layer,
  WriteTool.layer,
  WriteHexTool.layer,
  SpawnTool.layer,
  ExitTool.layer,
  WaitTool.layer,
)

export const node = makeLocationNode({
  name: "built-in-tools",
  layer: Layer.empty,
  deps: [
    ApplyPatchTool.node,
    BashTool.node,
    DefineToolTool.node,
    EditTool.node,
    GlobTool.node,
    GrepTool.node,
    JsTool.node,
    KbTool.node,
    MessengerTool.node,
    ProfileTool.node,
    QualityProvisionTool.node,
    QuestionTool.node,
    ReadTool.node,
    ReadHexTool.node,
    ReconfigureTool.node,
    RegisterAppTool.node,
    RevertTool.node,
    SkillTool.node,
    TodoWriteTool.node,
    ToolManualTool.node,
    TrashTool.node,
    WebFetchTool.node,
    WebSearchTool.node,
    WriteTool.node,
    WriteHexTool.node,
    SpawnTool.node,
    ExitTool.node,
    WaitTool.node,
  ],
})
