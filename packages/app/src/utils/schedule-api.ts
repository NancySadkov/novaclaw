import type { ServerConnection } from "@/context/server"
import { instanceFetch } from "@/utils/instance-fetch"

export interface ClockTime {
  readonly hour: number
  readonly minute: number
}

export type Recurrence =
  | { readonly kind: "once"; readonly at: number }
  | { readonly kind: "daily"; readonly time: ClockTime; readonly zone?: string }
  | { readonly kind: "weekly"; readonly time: ClockTime; readonly weekdays: readonly number[]; readonly zone?: string }
  | { readonly kind: "monthly"; readonly time: ClockTime; readonly day: number; readonly zone?: string }
  | {
      readonly kind: "yearly"
      readonly time: ClockTime
      readonly month: number
      readonly day: number
      readonly zone?: string
    }

export interface Schedule {
  readonly id: string
  readonly title: string
  readonly recurrence: Recurrence
  readonly tzOffsetMin: number
  readonly prompt: string
  readonly enabled: boolean
  readonly durationMinutes: number
  readonly heartbeatMinutes: number
  readonly escalateOnFailure: boolean
  readonly nextFireAt: number | null
  readonly lastFiredAt: number | null
  readonly timeCreated: number
  readonly timeUpdated: number
}

export interface ScheduleFire {
  readonly id: string
  readonly scheduleId: string
  readonly occurrenceMillis: number
  readonly firedAt: number
  readonly windowEndAt: number
  readonly lastHeartbeatAt: number | null
  readonly confirmedAt: number | null
  readonly failedAt: number | null
  readonly escalatedAt: number | null
  readonly nextHeartbeatAt: number | null
  readonly outcome: "pending" | "confirmed" | "failed"
}

export interface CreateScheduleInput {
  readonly title?: string
  readonly recurrence: Recurrence
  readonly tzOffsetMin?: number
  readonly prompt: string
  readonly enabled?: boolean
  readonly durationMinutes?: number
  readonly heartbeatMinutes?: number
  readonly escalateOnFailure?: boolean
}

export type UpdateScheduleInput = Partial<CreateScheduleInput>

const baseRoute = (agentID: string) => `api/agent/${encodeURIComponent(agentID)}/schedule`

export const listSchedules = (server: ServerConnection.HttpBase, agentID: string) =>
  instanceFetch<Schedule[]>(server, { method: "GET", route: baseRoute(agentID) })

export const createSchedule = (
  server: ServerConnection.HttpBase,
  directory: string,
  agentID: string,
  input: CreateScheduleInput,
) =>
  instanceFetch<Schedule>(server, {
    method: "POST",
    route: baseRoute(agentID),
    directory,
    directoryVia: "header",
    body: input,
  })

export const updateSchedule = (
  server: ServerConnection.HttpBase,
  directory: string,
  agentID: string,
  id: string,
  patch: UpdateScheduleInput,
) =>
  instanceFetch<Schedule>(server, {
    method: "PATCH",
    route: `${baseRoute(agentID)}/${encodeURIComponent(id)}`,
    directory,
    directoryVia: "header",
    body: patch,
  })

export const removeSchedule = (server: ServerConnection.HttpBase, agentID: string, id: string) =>
  instanceFetch<void>(server, { method: "DELETE", route: `${baseRoute(agentID)}/${encodeURIComponent(id)}` })

export const listScheduleFires = (server: ServerConnection.HttpBase, agentID: string) =>
  instanceFetch<ScheduleFire[]>(server, { method: "GET", route: `${baseRoute(agentID)}/fires` })
