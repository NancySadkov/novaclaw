import { Context } from "effect"
import { HttpApi, HttpApiGroup, HttpApiMiddleware, OpenApi } from "effect/unstable/httpapi"
import { SchemaErrorMiddleware } from "./middleware/schema-error"
import { MessageGroup } from "./groups/message"
import { ModelGroup } from "./groups/model"
import { ProviderGroup } from "./groups/provider"
import { makeSessionGroup } from "./groups/session"
import { makePermissionGroup } from "./groups/permission"
import { FileSystemGroup } from "./groups/fs"
import { CommandGroup } from "./groups/command"
import { SkillGroup } from "./groups/skill"
import { EventGroup, makeEventGroup } from "./groups/event"
import type { Definition } from "@novaclaw/schema/event"
import { AgentGroup } from "./groups/agent"
import { HealthGroup } from "./groups/health"
import { PtyGroup } from "./groups/pty"
import { PtyInstanceGroup } from "./groups/pty-instance"
import { makeQuestionGroup } from "./groups/question"
import { ReferenceGroup } from "./groups/reference"
import { Authorization } from "./middleware/authorization"
import { LocationGroup } from "./groups/location"
import { IntegrationGroup } from "./groups/integration"
import { CredentialGroup } from "./groups/credential"
import { MessengerGroup } from "./groups/messenger"
import { CalendarGroup } from "./groups/calendar"
import { RecipeGroup } from "./groups/recipe"
import { ConfigGroup } from "./groups/config"
import { LogGroup } from "./groups/log"
import { TelemetryGroup } from "./groups/telemetry"

// Protocol owns middleware placement, while Server injects concrete keys so Core service identities stay downstream.
const makeApiFromGroup = <
  const Group extends HttpApiGroup.Any,
  LocationId extends HttpApiMiddleware.AnyId,
  LocationService,
  SessionLocationId extends HttpApiMiddleware.AnyId,
  SessionLocationService,
  WorkspaceRoutingId extends HttpApiMiddleware.AnyId,
  WorkspaceRoutingService,
>(
  eventGroup: Group,
  locationMiddleware: Context.Key<LocationId, LocationService>,
  sessionLocationMiddleware: Context.Key<SessionLocationId, SessionLocationService>,
  // 🔴 Routes a request to the instance that OWNS its session. Threaded in rather than imported:
  // the implementation needs the control plane, which lives in a package that depends on this one.
  workspaceRoutingMiddleware: Context.Key<WorkspaceRoutingId, WorkspaceRoutingService>,
) =>
  HttpApi.make("server")
    .add(HealthGroup)
    .add(LocationGroup.middleware(locationMiddleware))
    .add(AgentGroup.middleware(locationMiddleware))
    // 🔴 **Every SESSION-SCOPED group carries `workspaceRoutingMiddleware`, and this list is the place
    // to check that.** A route naming a `:sessionID` may be for a session owned by a REMOTE workspace,
    // and without this it is served here — on the wrong machine, against the wrong working tree.
    //
    // ⚠️ The reply routes are the sharpest case. A remote session asks for permission, the user
    // answers, and the reply is handled LOCALLY: the session that is waiting never hears it and hangs
    // on an ask that was, from the user's side, answered. Session routing was added to
    // `makeSessionGroup` on 2026-08-07 and these three were missed in the same pass — the gap survives
    // exactly as long as the declaration is per-group and invisible from one place.
    .add(makeSessionGroup(locationMiddleware, sessionLocationMiddleware, workspaceRoutingMiddleware))
    .add(MessageGroup.middleware(sessionLocationMiddleware).middleware(workspaceRoutingMiddleware))
    .add(ModelGroup.middleware(locationMiddleware))
    .add(ProviderGroup.middleware(locationMiddleware))
    .add(IntegrationGroup.middleware(locationMiddleware))
    .add(CredentialGroup.middleware(locationMiddleware))
    .add(MessengerGroup)
    .add(CalendarGroup)
    .add(RecipeGroup)
    .add(makePermissionGroup(locationMiddleware, sessionLocationMiddleware).middleware(workspaceRoutingMiddleware))
    .add(FileSystemGroup.middleware(locationMiddleware))
    .add(CommandGroup.middleware(locationMiddleware))
    .add(SkillGroup.middleware(locationMiddleware))
    .add(eventGroup)
    .add(PtyGroup.middleware(locationMiddleware))
    // Instance-wide aggregation enumerates already-active location graphs; applying location
    // middleware here would build one merely by observing the instance.
    .add(PtyInstanceGroup)
    .add(makeQuestionGroup(locationMiddleware, sessionLocationMiddleware).middleware(workspaceRoutingMiddleware))
    .add(ReferenceGroup.middleware(locationMiddleware))
    // Instance-wide, so no location middleware: the config stores are global nodes.
    .add(ConfigGroup)
    // Instance-wide for the same reason: the log directory is `Global.Path.log`, one per instance.
    // A location would be the wrong axis — there is one log, not one per workspace.
    .add(LogGroup)
    // Ordinary-user maintenance-plane disclosure. Instance-wide and intentionally ungated by expertise.
    .add(TelemetryGroup)
    .annotateMerge(
      OpenApi.annotations({
        title: "novaclaw HttpApi",
        version: "0.0.1",
        description: "Experimental HttpApi surface for selected instance routes.",
      }),
    )
    .middleware(Authorization)
    .middleware(SchemaErrorMiddleware)

export const makeApi = <
  LocationId extends HttpApiMiddleware.AnyId,
  LocationService,
  SessionLocationId extends HttpApiMiddleware.AnyId,
  SessionLocationService,
  WorkspaceRoutingId extends HttpApiMiddleware.AnyId,
  WorkspaceRoutingService,
>(options: {
  readonly definitions: ReadonlyArray<Definition>
  readonly locationMiddleware: Context.Key<LocationId, LocationService>
  readonly sessionLocationMiddleware: Context.Key<SessionLocationId, SessionLocationService>
  readonly workspaceRoutingMiddleware: Context.Key<WorkspaceRoutingId, WorkspaceRoutingService>
}) =>
  makeApiFromGroup(
    makeEventGroup(options.definitions),
    options.locationMiddleware,
    options.sessionLocationMiddleware,
    options.workspaceRoutingMiddleware,
  )

export const makeDefaultApi = <
  LocationId extends HttpApiMiddleware.AnyId,
  LocationService,
  SessionLocationId extends HttpApiMiddleware.AnyId,
  SessionLocationService,
  WorkspaceRoutingId extends HttpApiMiddleware.AnyId,
  WorkspaceRoutingService,
>(options: {
  readonly locationMiddleware: Context.Key<LocationId, LocationService>
  readonly sessionLocationMiddleware: Context.Key<SessionLocationId, SessionLocationService>
  readonly workspaceRoutingMiddleware: Context.Key<WorkspaceRoutingId, WorkspaceRoutingService>
}) =>
  makeApiFromGroup(
    EventGroup,
    options.locationMiddleware,
    options.sessionLocationMiddleware,
    options.workspaceRoutingMiddleware,
  )
