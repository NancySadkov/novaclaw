import { Layer } from "effect"
import { MessageHandler } from "./handlers/message"
import { ModelHandler } from "./handlers/model"
import { ProviderHandler } from "./handlers/provider"
import { SessionHandler } from "./handlers/session"
import { PermissionHandler } from "./handlers/permission"
import { FileSystemHandler } from "./handlers/fs"
import { DirectoryBrowseHandler } from "./handlers/directory-browse"
import { CommandHandler } from "./handlers/command"
import { SkillHandler } from "./handlers/skill"
import { EventHandler } from "./handlers/event"
import { AgentHandler } from "./handlers/agent"
import { HealthHandler } from "./handlers/health"
import { MemoryHandler } from "./handlers/memory"
import { PtyHandler } from "./handlers/pty"
import { PtyInstanceHandler } from "./handlers/pty-instance"
import { ReferenceHandler } from "./handlers/reference"
import { LocationHandler } from "./handlers/location"
import { IntegrationHandler } from "./handlers/integration"
import { CredentialHandler } from "./handlers/credential"
import { MessengerHandler } from "./handlers/messenger"
import { CalendarHandler } from "./handlers/calendar"
import { RecipeHandler } from "./handlers/recipe"
import { AppHandler } from "./handlers/app"
import { ConfigHandler } from "./handlers/config"
import { LogHandler } from "./handlers/log"
import { TelemetryHandler } from "./handlers/telemetry"
import { QualityHandler } from "./handlers/quality"

type HandlerLayers =
  | typeof HealthHandler
  | typeof MemoryHandler
  | typeof LocationHandler
  | typeof AgentHandler
  | typeof SessionHandler
  | typeof MessageHandler
  | typeof ModelHandler
  | typeof ProviderHandler
  | typeof IntegrationHandler
  | typeof CredentialHandler
  | typeof MessengerHandler
  | typeof CalendarHandler
  | typeof RecipeHandler
  | typeof AppHandler
  | typeof PermissionHandler
  | typeof FileSystemHandler
  | typeof DirectoryBrowseHandler
  | typeof CommandHandler
  | typeof SkillHandler
  | typeof EventHandler
  | typeof PtyHandler
  | typeof PtyInstanceHandler
  | typeof ReferenceHandler
  | typeof ConfigHandler
  | typeof LogHandler
  | typeof TelemetryHandler
  | typeof QualityHandler

export const handlers: Layer.Layer<
  Layer.Success<HandlerLayers>,
  Layer.Error<HandlerLayers>,
  Layer.Services<HandlerLayers>
> = Layer.mergeAll(
  HealthHandler,
  MemoryHandler,
  LocationHandler,
  AgentHandler,
  SessionHandler,
  MessageHandler,
  ModelHandler,
  ProviderHandler,
  IntegrationHandler,
  CredentialHandler,
  MessengerHandler,
  CalendarHandler,
  RecipeHandler,
  AppHandler,
  PermissionHandler,
  FileSystemHandler,
  DirectoryBrowseHandler,
  CommandHandler,
  SkillHandler,
  EventHandler,
  PtyHandler,
  PtyInstanceHandler,
  ReferenceHandler,
  ConfigHandler,
  LogHandler,
  TelemetryHandler,
  QualityHandler,
)
