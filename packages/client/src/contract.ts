import { makeDefaultApi } from "@novaclaw/protocol/api"
import { InvalidRequestError, SessionNotFoundError } from "@novaclaw/protocol/errors"
import { HttpApiMiddleware } from "effect/unstable/httpapi"

class LocationMiddleware extends HttpApiMiddleware.Service<LocationMiddleware>()(
  "@novaclaw/client/LocationMiddleware",
) {}

class SessionLocationMiddleware extends HttpApiMiddleware.Service<SessionLocationMiddleware>()(
  "@novaclaw/client/SessionLocationMiddleware",
  { error: [InvalidRequestError, SessionNotFoundError] },
) {}

export const ClientApi = makeDefaultApi({
  locationMiddleware: LocationMiddleware,
  sessionLocationMiddleware: SessionLocationMiddleware,
})

export const groupNames = {
  "server.health": "health",
  "server.location": "location",
  "server.agent": "agents",
  "server.session": "sessions",
  "server.message": "messages",
  "server.model": "models",
  "server.provider": "providers",
  "server.integration": "integrations",
  "server.credential": "credentials",
  "server.messenger": "messenger",
  "server.calendar": "calendar",
  "server.recipe": "recipes",
  "server.permission": "permissions",
  "server.fs": "files",
  "server.command": "commands",
  "server.skill": "skills",
  "server.event": "events",
  "server.pty": "ptys",
  "server.question": "questions",
  "server.reference": "references",
  "server.projectCopy": "projectCopies",
} as const

export const endpointNames = {
  "session.messages": "list",
  "integration.connect.key": "connectKey",
  "integration.connect.oauth": "connectOauth",
  "integration.attempt.status": "attemptStatus",
  "integration.attempt.complete": "attemptComplete",
  "integration.attempt.cancel": "attemptCancel",
  "permission.request.list": "listRequests",
  "permission.saved.list": "listSaved",
  "permission.saved.remove": "removeSaved",
  "question.request.list": "listRequests",
  "messenger.driver.list": "listDrivers",
  "messenger.account.list": "listAccounts",
  "messenger.account.create": "createAccount",
  "messenger.account.update": "updateAccount",
  "messenger.account.remove": "removeAccount",
  "messenger.account.pair": "mintPairing",
  "messenger.login.begin": "loginBegin",
  "messenger.login.status": "loginStatus",
  "messenger.login.complete": "loginComplete",
  "messenger.login.cancel": "loginCancel",
  "messenger.account.chats": "listAccountChats",
  "messenger.binding.list": "listBindings",
  "messenger.binding.create": "createBinding",
  "messenger.binding.remove": "removeBinding",
  // Calendar: the generated client name is the LAST dot-segment, so schedule.list and fires.list
  // would both be `list` — name every endpoint explicitly, as messenger does.
  "calendar.schedule.list": "listSchedules",
  "calendar.schedule.create": "createSchedule",
  "calendar.schedule.update": "updateSchedule",
  "calendar.schedule.remove": "removeSchedule",
  "calendar.fires.list": "listFires",
} as const

export const omitEndpoints = new Set(["fs.read", "pty.connect", "pty.connectToken"])
