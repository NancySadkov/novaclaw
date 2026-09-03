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
import { MemoryEvent } from "./memory-event"
import { Messenger } from "./messenger"
import { ModelsDev } from "./models-dev"
import { Plugin } from "./plugin"
import { Pty } from "./pty"
import { Question } from "./question"
import { Reference } from "./reference"
import { ServerEvent } from "./server-event"
import { SessionCompactionEvent } from "./session-compaction-event"
import { SessionEvent } from "./session-event"
import { SessionPresence } from "./session-presence"
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
  // The memory store's lifecycle. SERVER-visible on purpose: auto-recall and auto-extraction run
  // inside the session worker, and `session-worker/services.ts` forwards a publish to the host bus
  // only for types in `ServerDefinitions`. Leaving them out would have made every memory event
  // raised by an actual turn a process-local no-op, which is the one producer the Memory app most
  // needs to see.
  ...MemoryEvent.Definitions,
  ...FileSystem.Event.Definitions,
  ...Reference.Event.Definitions,
  ...Plugin.Event.Definitions,
  ...FileSystemWatcher.Event.Definitions,
  ...Pty.Event.Definitions,
  ...Question.Event.Definitions,
  ...Messenger.Event.Definitions,
)

/**
 * What `/api/event` carries — the whole bus, minus the two server-lifecycle types below.
 *
 * ⚠️ Until 2026-09-03 this was the foundation, the features and three session families, and
 * `Definitions` added ten more families the contract stream then REFUSED (`session.status`,
 * `session.error`, `session.compacted`, `mcp.*`, `installation.*`, `vcs.branch.updated`,
 * `workspace.*`, `worktree.*`): the app's status row, error toast, updater and branch badge were
 * contract consumers waiting on exactly these, and the session worker had to whitelist
 * `session.status` past this set by hand to reach the host bus at all. The event-stream ledger
 * (`notes/reports/refactor-sweep-2026-08-31/24-contract-surface.md`) said "join" for each; they are joined. `permission.asked/replied` left instead:
 * the consent-card island that published them is gone, and a family nobody emits is not a contract.
 */
export const ServerDefinitions = Event.inventory(
  ...foundationDefinitions,
  ...recordLiveDefinitions,
  ...InstallationEvent.Definitions,
  ...featureDefinitions,
  ...SessionTodo.Event.Definitions,
  ...SessionTags.Event.Definitions,
  ...SessionPresence.Event.Definitions,
  ...McpEvent.Definitions,
  ...SessionStatusEvent.Definitions,
  ...SessionCompactionEvent.Definitions,
  ...VcsEvent.Definitions,
  ...WorkspaceEvent.Definitions,
  ...WorktreeEvent.Definitions,
)

/**
 * Everything the bus carries: the served set plus `server.connected` and `global.disposed`, which
 * the streams emit themselves (`/api/event` and `/event` open with `server.connected`;
 * `global.disposed` rides `/global/event`) and are therefore declared here for the union, not served
 * as bus events. Their shape reconciliation and the legacy element are the two rows of that ledger left.
 */
export const Definitions = Event.inventory(...ServerDefinitions, ...ServerEvent.Definitions)
export const Latest = Event.latest(Definitions)
export { Durable }
