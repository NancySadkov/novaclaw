import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { WorkProject } from "@novaclaw/schema/work-project"
import { InvalidRequestError } from "../errors"

export const WorkProjectGroup = HttpApiGroup.make("server.work-project")
  .add(
    HttpApiEndpoint.get("workProject.list", "/api/projects", { success: WorkProject.Snapshot }).annotateMerge(
      OpenApi.annotations({ identifier: "v2.workProject.list", summary: "List projects and assigned officers" }),
    ),
  )
  .add(
    HttpApiEndpoint.post("workProject.execute", "/api/projects", {
      payload: WorkProject.Command,
      success: WorkProject.Snapshot,
      error: InvalidRequestError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.workProject.execute",
        summary: "Manage a project or its officer assignments",
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "projects",
      description: "Project folders, officer assignments, and execution holds.",
    }),
  )
