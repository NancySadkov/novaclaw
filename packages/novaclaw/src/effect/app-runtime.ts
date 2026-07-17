import { Layer, ManagedRuntime } from "effect"
import { attach } from "./run-service"
import * as Observability from "@novaclaw/core/observability"

import { FSUtil } from "@novaclaw/core/fs-util"
import { Database } from "@novaclaw/core/database/database"
import { Auth } from "@/auth"
import { Account } from "@/account/account"
import { Config } from "@/config/config"
import { Git } from "@/git"
import { Ripgrep } from "@novaclaw/core/ripgrep"
import { Storage } from "@/storage/storage"
import { Snapshot } from "@/snapshot"
import { Plugin } from "@/plugin"
import { ModelsDev } from "@novaclaw/core/models-dev"
import { ProviderAuth } from "@/provider/auth"
import { Agent } from "@/agent/agent"
import { Skill } from "@/skill"
import { Discovery } from "@/skill/discovery"
import { Question } from "@/question"
import { Permission } from "@/permission"
import { Todo } from "@/session/todo"
import { MCP } from "@/mcp"
import { McpAuth } from "@/mcp/auth"
import { Truncate } from "@/tool/truncate"
import { Format } from "@/format"
import { InstanceLayer } from "@/project/instance-layer"
import { Vcs } from "@/project/vcs"
import { Workspace } from "@/control-plane/workspace"
import { Worktree } from "@/worktree"
import { Installation } from "@/installation"
import { Npm } from "@novaclaw/core/npm"
import { ProjectV2 } from "@novaclaw/core/project"
import { SessionStore } from "@novaclaw/core/session/store"
import { memoMap } from "@novaclaw/core/effect/memo-map"
import { BackgroundJob } from "@/background/job"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"

export const AppLayer = Layer.mergeAll(
  Npm.defaultLayer,
  FSUtil.defaultLayer,
  Database.defaultLayer,
  Auth.defaultLayer,
  Account.defaultLayer,
  Config.defaultLayer,
  Git.defaultLayer,
  Storage.defaultLayer,
  Snapshot.defaultLayer,
  Plugin.defaultLayer,
  ModelsDev.defaultLayer,
  ProviderAuth.defaultLayer,
  Agent.defaultLayer,
  Skill.defaultLayer,
  Discovery.defaultLayer,
  Question.defaultLayer,
  Permission.defaultLayer,
  Todo.defaultLayer,
  BackgroundJob.defaultLayer,
  RuntimeFlags.defaultLayer,
  EventV2Bridge.defaultLayer,
  MCP.defaultLayer,
  McpAuth.defaultLayer,
  Truncate.defaultLayer,
  Format.defaultLayer,
  // F1c-0 — the cycle-free core deps the CLI session commands ride (createSessionRecord/
  // removeSessionRecord/SessionRead take {db, events, projects, store} as plain values;
  // Database + EventV2Bridge are already in this graph, these two complete the set) — the
  // CLI stays off the full `SessionV2` layer, whose graph needs `LocationServiceMap`.
  ProjectV2.defaultLayer,
  SessionStore.defaultLayer,
  Vcs.defaultLayer,
  Workspace.defaultLayer,
  Worktree.appLayer,
  Installation.defaultLayer,
).pipe(
  Layer.provideMerge(Ripgrep.defaultLayer),
  Layer.provideMerge(InstanceLayer.layer),
  Layer.provideMerge(Observability.layer),
)

const rt = ManagedRuntime.make(AppLayer, { memoMap })
type Runtime = Pick<typeof rt, "runSync" | "runPromise" | "runPromiseExit" | "runFork" | "runCallback" | "dispose">

/** Services provided by AppRuntime — i.e. what an Effect run via AppRuntime.runPromise can yield. */
export type AppServices = ManagedRuntime.ManagedRuntime.Services<typeof rt>
const wrap = (effect: Parameters<typeof rt.runSync>[0]) => attach(effect as never) as never

export const AppRuntime: Runtime = {
  runSync(effect) {
    return rt.runSync(wrap(effect))
  },
  runPromise(effect, options) {
    return rt.runPromise(wrap(effect), options)
  },
  runPromiseExit(effect, options) {
    return rt.runPromiseExit(wrap(effect), options)
  },
  runFork(effect) {
    return rt.runFork(wrap(effect))
  },
  runCallback(effect) {
    return rt.runCallback(wrap(effect))
  },
  dispose: () => rt.dispose(),
}
