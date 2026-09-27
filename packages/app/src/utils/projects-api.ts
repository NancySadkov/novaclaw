import type { WorkProject } from "@novaclaw/schema/work-project"
import type { ServerConnection } from "@/context/server"
import { instanceFetch } from "./instance-fetch"

export interface ProjectsApi {
  list: () => Promise<WorkProject.Snapshot>
  execute: (command: WorkProject.Command) => Promise<WorkProject.Snapshot>
}

export const projectsApi = (server: ServerConnection.HttpBase, signal?: AbortSignal): ProjectsApi => ({
  list: () => instanceFetch(server, { route: "/api/projects", signal }),
  execute: (command) => instanceFetch(server, { route: "/api/projects", method: "POST", body: command, signal }),
})
