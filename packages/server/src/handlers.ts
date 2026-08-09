import { Layer } from "effect"
import { MessageHandler } from "./handlers/message"
import { ModelHandler } from "./handlers/model"
import { ProviderHandler } from "./handlers/provider"
import { SessionHandler } from "./handlers/session"
import { PermissionHandler } from "./handlers/permission"
import { FileSystemHandler } from "./handlers/fs"
import { CommandHandler } from "./handlers/command"
import { SkillHandler } from "./handlers/skill"
import { EventHandler } from "./handlers/event"
import { AgentHandler } from "./handlers/agent"
import { HealthHandler } from "./handlers/health"
import { PtyHandler } from "./handlers/pty"
import { PtyInstanceHandler } from "./handlers/pty-instance"
import { QuestionHandler } from "./handlers/question"
import { ReferenceHandler } from "./handlers/reference"
import { LocationHandler } from "./handlers/location"
import { IntegrationHandler } from "./handlers/integration"
import { CredentialHandler } from "./handlers/credential"
import { MessengerHandler } from "./handlers/messenger"
import { CalendarHandler } from "./handlers/calendar"
import { RecipeHandler } from "./handlers/recipe"
import { ConfigHandler } from "./handlers/config"
import { LogHandler } from "./handlers/log"
import { TelemetryHandler } from "./handlers/telemetry"

type HandlerLayers =
  | typeof HealthHandler
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
  | typeof PermissionHandler
  | typeof FileSystemHandler
  | typeof CommandHandler
  | typeof SkillHandler
  | typeof EventHandler
  | typeof PtyHandler
  | typeof PtyInstanceHandler
  | typeof QuestionHandler
  | typeof ReferenceHandler
  | typeof ConfigHandler
  | typeof LogHandler
  | typeof TelemetryHandler

export const handlers: Layer.Layer<
  Layer.Success<HandlerLayers>,
  Layer.Error<HandlerLayers>,
  Layer.Services<HandlerLayers>
> = Layer.mergeAll(
  HealthHandler,
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
  PermissionHandler,
  FileSystemHandler,
  CommandHandler,
  SkillHandler,
  EventHandler,
  PtyHandler,
  PtyInstanceHandler,
  QuestionHandler,
  ReferenceHandler,
  ConfigHandler,
  LogHandler,
  TelemetryHandler,
)
