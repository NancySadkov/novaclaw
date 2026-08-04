import type { ServerConnection } from "@/context/server"
import { instanceFetch } from "@/utils/instance-fetch"

// Raw-fetch client for /api/calendar/schedule. Schedules are instance-global, so `server` (base URL
// + creds) is the only routing needed — no `directory`.
//
// ⚠️ Base URL, auth, and fault decoding all live in `utils/instance-fetch.ts`; nothing HTTP-shaped
// belongs in this file. It used to say these routes are "NOT in the generated SDK" — measured false
// on 2026-07-31 (`/api/calendar/*` is in `sdk.gen.ts`). Moving onto the SDK is a separate decision;
// this file is a typed shape over the shared seam until it is made.

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

const call = <T>(server: ServerConnection.HttpBase, method: string, route: string, body?: unknown): Promise<T> =>
  instanceFetch<T>(server, { method, route, body })

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

export const updateSchedule = (server: ServerConnection.HttpBase, id: string, patch: UpdateScheduleInput) =>
  call<Schedule>(server, "PATCH", `api/calendar/schedule/${encodeURIComponent(id)}`, patch)

export const removeSchedule = (server: ServerConnection.HttpBase, id: string) =>
  call<void>(server, "DELETE", `api/calendar/schedule/${encodeURIComponent(id)}`)

export const listFires = (server: ServerConnection.HttpBase) => call<Fire[]>(server, "GET", "api/calendar/fires")
