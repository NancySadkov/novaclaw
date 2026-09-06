export * as EventManifest from "./event-manifest"

import { AppEvent } from "./app-event"
import { AgentStatusEvent } from "./agent-status-event"
import { Catalog } from "./catalog"
import { Durable } from "./durable-event-manifest"
import { Event } from "./event"
import { FileSystem } from "./filesystem"
import { FileSystemWatcher } from "./filesystem-watcher"
import { InstallationEvent } from "./installation-event"
import { InstanceEvent } from "./instance-event"
import { Integration } from "./integration"
import { McpEvent } from "./mcp-event"
import { MemoryEvent } from "./memory-event"
import { Messenger } from "./messenger"
import { ModelsDev } from "./models-dev"
import { Plugin } from "./plugin"
import { Pty } from "./pty"
import { Reference } from "./reference"
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
  ...AgentStatusEvent.Definitions,
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
  ...InstanceEvent.Definitions,
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
 * Everything the bus carries — and since 2026-09-03 that is exactly the served set, so
 * `/api/event` refuses nothing.
 *
 * ⚠️ `server.connected` and `global.disposed` used to sit here too, and neither was ever a bus
 * event: the STREAMS synthesize them. `/api/event` opens with `server.connected` (the arm is
 * declared by `protocol/groups/event.ts` itself, which adds it when the definitions do not carry
 * one), and `global.disposed` is a `GlobalBus` payload `/global/event` relays, declared by that
 * route's own element schema. Keeping them in the bus inventory made two claims that were both
 * false — that something publishes them through `EventV2.publish`, and that a stream refusing them
 * was a GAP rather than the two sides of one contract meeting. A manifest entry with no publisher
 * is the same defect the `question` and `permission` families were deleted for.
 */
export const Definitions = ServerDefinitions
export const Latest = Event.latest(Definitions)
export { Durable }
