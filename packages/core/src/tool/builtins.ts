export * as BuiltInTools from "./builtins"

import { makeLocationNode } from "../effect/app-node"
import { Layer } from "effect"
import { BashTool } from "./bash"
import { BashJobs } from "./bash-jobs"
import { ApplyPatchTool } from "./apply-patch"
import { ConfigureTool } from "./configure"
import { DefineToolTool } from "./define-tool"
import { EditTool } from "./edit"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import { JsTool } from "./js"
import { KbTool } from "./kb"
import { MessengerTool } from "./messenger"
import { PermissionTool } from "./permission"
import { ProfileTool } from "./profile"
import { QualityProvisionTool } from "./quality-provision"
import { QuestionTool } from "./question"
import { ReadTool } from "./read"
import { ReconfigureTool } from "./reconfigure"
import { ResourceStatusTool } from "./resource-status"
import { ReadHexTool } from "./read-hex"
import { ReadToolFileSystem } from "./read-filesystem"
import { RecipeTool } from "./recipe"
import { RegisterAppTool } from "./register-app"
import { RevertTool } from "./revert"
import { SkillTool } from "./skill"
import { TodoWriteTool } from "./todowrite"
import { ToolManualTool } from "./tool-manual"
import { ToolCallTool } from "./tool-call"
import { ToolSearchTool } from "./tool-search"
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
 * TODO: Port the remaining launch-follow-up leaves deliberately:
 * parity, task,
 * repo_clone, repo_overview, plan_exit, and Rune/code mode. Keep MCP and plugin
 * transforms separate from this static built-in list.
 */
export const locationLayer = Layer.mergeAll(
  ApplyPatchTool.layer,
  BashTool.layer.pipe(Layer.provide(BashJobs.layer)),
  // Registered under its own name with no `Tool.withPermission` wrap, for `recipe.ts`'s reason: the
  // name fallback in `tool.ts` already resolves it, and `validateRegistration` refuses a declaration
  // that repeats the name. ⚠️ `configure` spends TWO actions rather than one — `configure` for a
  // consequential key and `configure_privileged` for a privileged one (ruling 4's tiers; see
  // `configure.ts`) — and neither is declarable through `withPermission`, which carries a single
  // action. The tiering lives in the asserts, which is where a per-key decision belongs.
  ConfigureTool.layer,
  DefineToolTool.layer,
  EditTool.layer,
  GlobTool.layer,
  GrepTool.layer,
  JsTool.layer,
  KbTool.layer,
  MessengerTool.layer,
  // Auto mode (`tool/permission.ts`). Registered under its own name with no `Tool.withPermission`
  // wrap, for the same reason `configure` and `recipe` are: the name fallback in `tool.ts` already
  // makes it answer to `permission`, and `validateRegistration` REFUSES a declaration that repeats
  // the registration key. ⚠️ Like `configure` it spends a SECOND action — `permission_privileged`,
  // for the one raise that routes through the ask (a return to `yolo`) — and a second action is not
  // declarable through `withPermission`, which carries one. The split lives in the assert, which is
  // where a per-target decision belongs.
  PermissionTool.layer,
  ProfileTool.layer,
  QualityProvisionTool.layer,
  QuestionTool.layer,
  ReadTool.layer.pipe(Layer.provide(ReadToolFileSystem.layer)),
  ReadHexTool.layer,
  // Registered under its own name with no `Tool.withPermission` wrap: the permission fallback in
  // `tool.ts` already makes a tool answer to the name it is registered under, and
  // `validateRegistration` REFUSES a declaration that repeats it (that shape reads as a gate while
  // gating nothing). `recipe.ts` asserts the `recipe` action itself, on `save` only.
  RecipeTool.layer,
  ReconfigureTool.layer,
  ResourceStatusTool.layer,
  RegisterAppTool.layer,
  RevertTool.layer,
  SkillTool.layer,
  TodoWriteTool.layer,
  ToolManualTool.layer,
  ToolCallTool.layer,
  ToolSearchTool.layer,
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
    ConfigureTool.node,
    DefineToolTool.node,
    EditTool.node,
    GlobTool.node,
    GrepTool.node,
    JsTool.node,
    KbTool.node,
    MessengerTool.node,
    PermissionTool.node,
    ProfileTool.node,
    QualityProvisionTool.node,
    QuestionTool.node,
    ReadTool.node,
    ReadHexTool.node,
    RecipeTool.node,
    ReconfigureTool.node,
    ResourceStatusTool.node,
    RegisterAppTool.node,
    RevertTool.node,
    SkillTool.node,
    TodoWriteTool.node,
    ToolManualTool.node,
    ToolCallTool.node,
    ToolSearchTool.node,
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
