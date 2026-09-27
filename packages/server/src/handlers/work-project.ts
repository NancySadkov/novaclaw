import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { WorkProjects } from "@novaclaw/core/work-project/store"
import { InvalidRequestError } from "@novaclaw/protocol/errors"
import { WorkProjectApi, handlerLayer } from "../handler-api"

export const WorkProjectHandler = handlerLayer(
  HttpApiBuilder.group(WorkProjectApi, "server.work-project", (handlers) =>
    Effect.gen(function* () {
      const projects = yield* WorkProjects.Service
      return handlers
        .handle("workProject.list", () => projects.execute({ op: "list" }).pipe(Effect.orDie))
        .handle("workProject.execute", (context) =>
          projects
            .execute(context.payload)
            .pipe(Effect.mapError((error) => new InvalidRequestError({ message: error.message }))),
        )
    }),
  ),
)
