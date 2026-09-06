import { Context } from "effect"
import { HttpApi, HttpApiGroup, HttpApiMiddleware, OpenApi } from "effect/unstable/httpapi"
import { SchemaErrorMiddleware } from "./middleware/schema-error"
import { MessageGroup } from "./groups/message"
import { ModelGroup } from "./groups/model"
import { ProviderGroup } from "./groups/provider"
import { makeSessionGroups } from "./groups/session"
import { makePermissionGroup } from "./groups/permission"
import { DirectoryBrowseGroup, FileSystemGroup } from "./groups/fs"
import { CommandGroup } from "./groups/command"
import { QualityGroup } from "./groups/quality"
import { VcsGroup } from "./groups/vcs"
import { SkillGroup } from "./groups/skill"
import { EventGroup } from "./groups/event"
import { AgentGroup } from "./groups/agent"
import { HealthGroup } from "./groups/health"
import { MemoryGroup } from "./groups/memory"
import { PtyGroup } from "./groups/pty"
import { PtyInstanceGroup } from "./groups/pty-instance"
import { ReferenceGroup } from "./groups/reference"
import { Authorization } from "./middleware/authorization"
import { LocationGroup } from "./groups/location"
import { IntegrationGroup } from "./groups/integration"
import { CredentialGroup } from "./groups/credential"
import { MessengerGroup } from "./groups/messenger"
import { makeCalendarGroup } from "./groups/calendar"
import { RecipeGroup } from "./groups/recipe"
import { AppGroup } from "./groups/app"
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
    .add(MemoryGroup)
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
    .add(...makeSessionGroups(locationMiddleware, sessionLocationMiddleware, workspaceRoutingMiddleware))
    .add(MessageGroup.middleware(sessionLocationMiddleware).middleware(workspaceRoutingMiddleware))
    .add(ModelGroup.middleware(locationMiddleware))
    .add(ProviderGroup.middleware(locationMiddleware))
    .add(IntegrationGroup.middleware(locationMiddleware))
    .add(CredentialGroup.middleware(locationMiddleware))
    .add(MessengerGroup)
    .add(makeCalendarGroup(locationMiddleware))
    .add(RecipeGroup)
    .add(AppGroup)
    .add(makePermissionGroup(locationMiddleware, sessionLocationMiddleware).middleware(workspaceRoutingMiddleware))
    .add(FileSystemGroup.middleware(locationMiddleware))
    .add(DirectoryBrowseGroup)
    .add(CommandGroup.middleware(locationMiddleware))
    // Location-scoped like `fs` and for the same reason: a diff belongs to one working tree.
    .add(VcsGroup.middleware(locationMiddleware))
    // Location-scoped: the manifests it reads are the ones in THAT working tree.
    .add(QualityGroup.middleware(locationMiddleware))
    .add(SkillGroup.middleware(locationMiddleware))
    .add(eventGroup)
    .add(PtyGroup.middleware(locationMiddleware))
    // Instance-wide aggregation enumerates already-active location graphs; applying location
    // middleware here would build one merely by observing the instance.
    .add(PtyInstanceGroup)
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
        // ⚠️ **This description is a FALLBACK, and its job is to never be used.** `HttpApi.addHttpApi`
        // merges an embedded API's annotations into each of its groups, so any group here that
        // declares no `title`/`description` of its own is published under THESE — nineteen
        // operations, the whole `/api/memory/*` surface among them, once carried the literal tag
        // name "novaclaw HttpApi" and told a stranger the routes were experimental and partial.
        // Every group now names itself, which `test/openapi-tags.test.ts` holds shut.
        description:
          "The instance's `/api/*` contract: sessions, agents, models, memory and the rest of the OS surface.",
      }),
    )
    .middleware(Authorization)
    .middleware(SchemaErrorMiddleware)

type ApiFromGroup<
  Group extends HttpApiGroup.Any,
  LocationId extends HttpApiMiddleware.AnyId,
  LocationService,
  SessionLocationId extends HttpApiMiddleware.AnyId,
  SessionLocationService,
  WorkspaceRoutingId extends HttpApiMiddleware.AnyId,
  WorkspaceRoutingService,
> = HttpApi.HttpApi<
  "server",
  HttpApiGroup.AddMiddleware<
    HttpApiGroup.AddMiddleware<
      | typeof HealthGroup
      | typeof MemoryGroup
      | HttpApiGroup.AddMiddleware<typeof LocationGroup, LocationId>
      | HttpApiGroup.AddMiddleware<typeof AgentGroup, LocationId>
      | ReturnType<
          typeof makeSessionGroups<
            LocationId,
            LocationService,
            SessionLocationId,
            SessionLocationService,
            WorkspaceRoutingId,
            WorkspaceRoutingService
          >
        >[number]
      | HttpApiGroup.AddMiddleware<
          HttpApiGroup.AddMiddleware<typeof MessageGroup, SessionLocationId>,
          WorkspaceRoutingId
        >
      | HttpApiGroup.AddMiddleware<typeof ModelGroup, LocationId>
      | HttpApiGroup.AddMiddleware<typeof ProviderGroup, LocationId>
      | HttpApiGroup.AddMiddleware<typeof IntegrationGroup, LocationId>
      | HttpApiGroup.AddMiddleware<typeof CredentialGroup, LocationId>
      | typeof MessengerGroup
      | ReturnType<typeof makeCalendarGroup<LocationId, LocationService>>
      | typeof RecipeGroup
      | typeof AppGroup
      | HttpApiGroup.AddMiddleware<
          ReturnType<
            typeof makePermissionGroup<LocationId, LocationService, SessionLocationId, SessionLocationService>
          >,
          WorkspaceRoutingId
        >
      | HttpApiGroup.AddMiddleware<typeof FileSystemGroup, LocationId>
      | typeof DirectoryBrowseGroup
      | HttpApiGroup.AddMiddleware<typeof CommandGroup, LocationId>
      | HttpApiGroup.AddMiddleware<typeof VcsGroup, LocationId>
      | HttpApiGroup.AddMiddleware<typeof QualityGroup, LocationId>
      | HttpApiGroup.AddMiddleware<typeof SkillGroup, LocationId>
      | Group
      | HttpApiGroup.AddMiddleware<typeof PtyGroup, LocationId>
      | typeof PtyInstanceGroup
      | HttpApiGroup.AddMiddleware<typeof ReferenceGroup, LocationId>
      | typeof ConfigGroup
      | typeof LogGroup
      | typeof TelemetryGroup,
      Authorization
    >,
    SchemaErrorMiddleware
  >
>

/**
 * 🔴 **There is ONE build of this API, and that is the point.**
 *
 * A second entry point took a `definitions` array and built the event group from it, which let a
 * caller publish a `GET /api/event` contract naming arms the served handler narrows away — the
 * parameter was checked against nothing, so the spec and the route drifted in silence and a
 * conforming client waited forever for a type that could never arrive. It was deleted once its last
 * caller moved to `runtimeApi()`; the divergence is now not a bug you can reintroduce here but a
 * statement that cannot be written. `git log -S makeEventGroup` has the shape if it is ever wanted.
 */
export function makeDefaultApi<
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
}): ApiFromGroup<
  typeof EventGroup,
  LocationId,
  LocationService,
  SessionLocationId,
  SessionLocationService,
  WorkspaceRoutingId,
  WorkspaceRoutingService
> {
  return makeApiFromGroup(
    EventGroup,
    options.locationMiddleware,
    options.sessionLocationMiddleware,
    options.workspaceRoutingMiddleware,
  )
}
