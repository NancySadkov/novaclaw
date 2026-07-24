import type { ServerConnection } from "@/context/server"
import { authTokenFromCredentials } from "@/utils/server"

// Raw-fetch client for /api/calendar/schedule — NOT in the generated SDK (golden rule: never hand-edit
// packages/sdk/**/gen/**). Mirrors messenger-api.ts / scheduler-api.ts. Schedules are instance-global, so
// `server` (base URL + creds) is the only routing needed.

export interface HM {
  readonly hour: number
  readonly minute: number
}

export type Recurrence =
  | { readonly kind: "once"; readonly at: number }
  | { readonly kind: "daily"; readonly time: HM }
  | { readonly kind: "weekly"; readonly time: HM; readonly weekdays: number[] }
  | { readonly kind: "monthly"; readonly time: HM; readonly day: number }
  | { readonly kind: "yearly"; readonly time: HM; readonly month: number; readonly day: number }

export interface Schedule {
  readonly id: string
  readonly title: string
  readonly recurrence: Recurrence
  readonly tzOffsetMin: number
  readonly prompt: string
  readonly agent: string | null
  readonly model: string | null
  readonly location: string | null
  readonly permissionMode: string | null
  readonly enabled: boolean
  readonly nextFireAt: number | null
  readonly lastFiredAt: number | null
  readonly timeCreated: number
  readonly timeUpdated: number
}

export interface Fire {
  readonly id: string
  readonly scheduleId: string
  readonly occurrenceMillis: number
  readonly firedAt: number
  readonly sessionId: string | null
  readonly status: "spawned" | "skipped" | "error"
}

export interface CreateScheduleInput {
  readonly title?: string
  readonly recurrence: Recurrence
  readonly tzOffsetMin?: number
  readonly prompt: string
  readonly agent?: string
  readonly model?: string
  readonly location?: string
  readonly permissionMode?: string
  readonly enabled?: boolean
}

async function call<T>(
  server: ServerConnection.HttpBase,
  method: string,
  route: string,
  body?: unknown,
): Promise<T> {
  const url = new URL(route, server.url.endsWith("/") ? server.url : `${server.url}/`)
  const res = await fetch(url, {
    method,
    headers: {
      "content-type": "application/json",
      ...(server.password
        ? { Authorization: `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}` }
        : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (res.status === 204) return undefined as T
  if (!res.ok) throw new Error(`${method} ${route} failed: ${res.status}`)
  return (await res.json()) as T
}

export const listSchedules = (server: ServerConnection.HttpBase) =>
  call<Schedule[]>(server, "GET", "api/calendar/schedule")

export const createSchedule = (server: ServerConnection.HttpBase, input: CreateScheduleInput) =>
  call<Schedule>(server, "POST", "api/calendar/schedule", input)

export interface UpdateScheduleInput {
  readonly title?: string
  readonly recurrence?: Recurrence
  readonly tzOffsetMin?: number
  readonly prompt?: string
  readonly agent?: string | null
  readonly model?: string | null
  readonly location?: string | null
  readonly permissionMode?: string | null
  readonly enabled?: boolean
}

export const updateSchedule = (
  server: ServerConnection.HttpBase,
  id: string,
  patch: UpdateScheduleInput,
) => call<Schedule>(server, "PATCH", `api/calendar/schedule/${encodeURIComponent(id)}`, patch)

export const removeSchedule = (server: ServerConnection.HttpBase, id: string) =>
  call<void>(server, "DELETE", `api/calendar/schedule/${encodeURIComponent(id)}`)

export const listFires = (server: ServerConnection.HttpBase) =>
  call<Fire[]>(server, "GET", "api/calendar/fires")
