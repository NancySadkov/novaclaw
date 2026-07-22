export * as EventManifest from "./event-manifest"

import { AppEvent } from "./app-event"
import { Catalog } from "./catalog"
import { Durable } from "./durable-event-manifest"
import { Event } from "./event"
import { FileSystem } from "./filesystem"
import { FileSystemWatcher } from "./filesystem-watcher"
import { InstallationEvent } from "./installation-event"
import { Integration } from "./integration"
import { McpEvent } from "./mcp-event"
import { Messenger } from "./messenger"
import { ModelsDev } from "./models-dev"
import { Permission } from "./permission"
import { PermissionRuleset } from "./permission-ruleset"
import { Plugin } from "./plugin"
import { Pty } from "./pty"
import { Question } from "./question"
import { QuestionRequest } from "./question-request"
import { Reference } from "./reference"
import { ServerEvent } from "./server-event"
import { SessionCompactionEvent } from "./session-compaction-event"
import { SessionEvent } from "./session-event"
import { SessionStatusEvent } from "./session-status-event"
import { SessionTags } from "./session-tags"
import { SessionTodo } from "./session-todo"
import { SessionRecordEvent } from "./session-record-event"
import { VcsEvent } from "./vcs-event"
import { WorkspaceEvent } from "./workspace-event"
import { WorktreeEvent } from "./worktree-event"

// V1-nuke slice D: the record lifecycle events are native (payload = Session.Info, durable v2);
// session.diff + command.executed died (no publishers).
const recordDurableDefinitions = SessionRecordEvent.Definitions.filter((definition) => definition.durable !== undefined)
const recordLiveDefinitions = SessionRecordEvent.Definitions.filter((definition) => definition.durable === undefined)

const coreDefinitions = Event.inventory(...recordDurableDefinitions, ...SessionEvent.Definitions)

const foundationDefinitions = Event.inventory(
  ...ModelsDev.Event.Definitions,
  ...Integration.Event.Definitions,
  ...Catalog.Event.Definitions,
  ...coreDefinitions,
)

const featureDefinitions = Event.inventory(
  ...AppEvent.Definitions,
  ...FileSystem.Event.Definitions,
  ...Reference.Event.Definitions,
  ...Permission.Event.Definitions,
  ...Plugin.Event.Definitions,
  ...FileSystemWatcher.Event.Definitions,
  ...Pty.Event.Definitions,
  ...Question.Event.Definitions,
  ...Messenger.Event.Definitions,
)

export const ServerDefinitions = Event.inventory(
  ...foundationDefinitions,
  ...featureDefinitions,
  ...SessionTodo.Event.Definitions,
  ...SessionTags.Event.Definitions,
)

export const Definitions = Event.inventory(
  ...foundationDefinitions,
  ...recordLiveDefinitions,
  ...InstallationEvent.Definitions,
  ...featureDefinitions,
  ...SessionTodo.Event.Definitions,
  ...SessionTags.Event.Definitions,
  ...PermissionRuleset.Event.Definitions,
  ...McpEvent.Definitions,
  ...SessionStatusEvent.Definitions,
  ...QuestionRequest.Event.Definitions,
  ...SessionCompactionEvent.Definitions,
  ...VcsEvent.Definitions,
  ...WorkspaceEvent.Definitions,
  ...WorktreeEvent.Definitions,
  ...ServerEvent.Definitions,
)
export const Latest = Event.latest(Definitions)
export { Durable }
