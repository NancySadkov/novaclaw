import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { HttpApi } from "effect/unstable/httpapi"
import { Recurrence } from "@novaclaw/core/schedule/recurrence"
import { PermissionMode } from "@novaclaw/schema/session-message"
import {
  CreateInput as WireCreateInput,
  Recurrence as WireRecurrence,
  Schedule as WireSchedule,
} from "@novaclaw/protocol/groups/calendar"
import { CalendarApi } from "../handler-api"

/**
 * ─── THE WIRE'S RECURRENCE IS THE ENGINE'S RECURRENCE ────────────────────────────────────────────
 *
 * `POST /api/calendar/schedule` used to answer **201 with the stored row** for a rule the scheduler
 * can never run: `weekdays: [7]`, `weekdays: []`, `{kind:"monthly", day:0}`. `nextFire` then scans
 * its 800 days, `matchesDay` is never true, `next_fire_at` is written `null`, and the schedule sits
 * in the Calendar app reading `enabled: true` and never fires. That is a failed mutation reporting
 * success — the caller was told "scheduled" for something that cannot happen. `{"hour":25}` is the
 * worse one: `Date.UTC(y,m,d,25,0)` rolls into the next day at 01:00, so it fires, at the wrong hour
 * on the wrong day, silently.
 *
 * 🔴 **The two halves have to be checked TOGETHER, and this package is the only one that can.**
 * `@novaclaw/protocol` depends on `@novaclaw/schema` and nothing else, so it cannot see the engine;
 * `@novaclaw/core` does not know the wire. A bound copied into the schema and asserted only against
 * itself is a hand-kept subset that goes stale in the direction that looks fine. So the assertion
 * below is a JOIN: every recurrence the wire ACCEPTS is handed straight to `Recurrence.nextFire`
 * and must produce an instant.
 *
 * ⚠️ **The handoff is written without a cast on purpose.** A `ctx.payload as unknown as
 * CalendarStore.CreateInput` in the handler is exactly what stopped the compiler from noticing that
 * `weekdays: number[]` and `ReadonlyArray<Weekday>` are not the same type. If the decoded value
 * below ever stops being assignable to the engine's `Recurrence`, this file stops compiling — which
 * is the point.
 */

const decode = <S extends Schema.Top>(schema: S, value: unknown): { ok: boolean; message: string } => {
  try {
    // The only cast in this file, and it is about REFLECTION, not about the domain: `HttpApi.reflect`
    // hands back `Schema.Top`, while `decodeUnknownSync` asks for a `Decoder<unknown>` — a schema with
    // no decoding requirements. Every served payload is one; the reflected type just cannot say so.
    // The handoff to `Recurrence.nextFire` below stays cast-free, which is the join that matters.
    Schema.decodeUnknownSync(schema as unknown as Schema.Decoder<unknown>)(value)
    return { ok: true, message: "" }
  } catch (error) {
    return { ok: false, message: String((error as Error).message).replace(/\s+/g, " ") }
  }
}

/** The schemas the SERVED endpoints actually carry, so this file cannot pass against an unused copy. */
const servedCreatePayload = (() => {
  let found: Schema.Top | undefined
  HttpApi.reflect(CalendarApi, {
    onGroup() {},
    onEndpoint({ endpoint }) {
      if (endpoint.name === "calendar.schedule.create") found = endpoint.payload.get("application/json")?.schemas[0]
    },
  })
  return found
})()

const servedCreateSuccess = (() => {
  let found: Schema.Top | undefined
  HttpApi.reflect(CalendarApi, {
    onGroup() {},
    onEndpoint({ endpoint }) {
      if (endpoint.name === "calendar.schedule.create") found = [...endpoint.success][0]
    },
  })
  return found
})()

const AFTER = Date.UTC(2026, 0, 1, 0, 0)
const base = { prompt: "write the morning report", tzOffsetMin: 60 }
const at = (hour: number, minute: number) => ({ hour, minute })

/** Boundary values of the engine's own domain, every one of which it can run. */
const RUNNABLE: ReadonlyArray<{ readonly label: string; readonly recurrence: unknown }> = [
  { label: "once, later today", recurrence: { kind: "once", at: AFTER + 60_000 } },
  { label: "daily at midnight", recurrence: { kind: "daily", time: at(0, 0) } },
  { label: "daily at 23:59", recurrence: { kind: "daily", time: at(23, 59) } },
  ...[0, 1, 2, 3, 4, 5, 6].map((day) => ({
    label: `weekly on weekday ${day}`,
    recurrence: { kind: "weekly", time: at(9, 0), weekdays: [day] },
  })),
  { label: "weekly on every weekday", recurrence: { kind: "weekly", time: at(9, 0), weekdays: [0, 1, 2, 3, 4, 5, 6] } },
  { label: "monthly on the 1st", recurrence: { kind: "monthly", time: at(9, 0), day: 1 } },
  // 31 is the clamp case: February has no 31st, so the engine fires on the month's last day.
  { label: "monthly on the 31st", recurrence: { kind: "monthly", time: at(9, 0), day: 31 } },
  { label: "yearly in January", recurrence: { kind: "yearly", time: at(9, 0), month: 1, day: 1 } },
  { label: "yearly in December", recurrence: { kind: "yearly", time: at(9, 0), month: 12, day: 31 } },
  // Feb 29 in a non-leap year clamps to Feb 28 — inside MAX_SCAN_DAYS either way.
  { label: "yearly on Feb 29", recurrence: { kind: "yearly", time: at(9, 0), month: 2, day: 29 } },
]

/**
 * Rules the engine cannot run, each paired with the token the refusal must name. A refusal that says
 * only "invalid" leaves the caller guessing which of six fields it was.
 */
const UNRUNNABLE: ReadonlyArray<{ readonly label: string; readonly recurrence: unknown; readonly names: string }> = [
  { label: "weekday 7", recurrence: { kind: "weekly", time: at(9, 0), weekdays: [7] }, names: "weekdays" },
  { label: "weekday -1", recurrence: { kind: "weekly", time: at(9, 0), weekdays: [-1] }, names: "weekdays" },
  { label: "no weekdays at all", recurrence: { kind: "weekly", time: at(9, 0), weekdays: [] }, names: "weekdays" },
  { label: "hour 24", recurrence: { kind: "daily", time: at(24, 0) }, names: "hour" },
  { label: "hour 25", recurrence: { kind: "daily", time: at(25, 0) }, names: "hour" },
  { label: "hour -1", recurrence: { kind: "daily", time: at(-1, 0) }, names: "hour" },
  { label: "minute 60", recurrence: { kind: "daily", time: at(9, 60) }, names: "minute" },
  { label: "fractional hour", recurrence: { kind: "daily", time: at(9.5, 0) }, names: "hour" },
  { label: "monthly day 0", recurrence: { kind: "monthly", time: at(9, 0), day: 0 }, names: "day" },
  { label: "monthly day 32", recurrence: { kind: "monthly", time: at(9, 0), day: 32 }, names: "day" },
  { label: "yearly month 0", recurrence: { kind: "yearly", time: at(9, 0), month: 0, day: 1 }, names: "month" },
  { label: "yearly month 13", recurrence: { kind: "yearly", time: at(9, 0), month: 13, day: 1 }, names: "month" },
  // The JSON stand-ins `Schema.Number` admits. Every comparison against them is false, so they are
  // the never-fires case wearing a number — and `once` at `Infinity` is never due either.
  { label: "hour NaN", recurrence: { kind: "daily", time: { hour: "NaN", minute: 0 } }, names: "hour" },
  { label: "once at NaN", recurrence: { kind: "once", at: "NaN" }, names: "at" },
  { label: "once at Infinity", recurrence: { kind: "once", at: "Infinity" }, names: "at" },
]

describe("the calendar wire's runnable domain", () => {
  test("the served create endpoint is the schema this file checks", () => {
    expect(servedCreatePayload).toBeDefined()
    expect(servedCreateSuccess).toBeDefined()
    // Same fixtures through the endpoint's own schema: an exported copy nothing serves would pass
    // every other case in this file while the route stayed wide open.
    for (const { label, recurrence } of RUNNABLE)
      expect(decode(servedCreatePayload!, { ...base, recurrence }).ok, `served accepts ${label}`).toBe(true)
    for (const { label, recurrence } of UNRUNNABLE)
      expect(decode(servedCreatePayload!, { ...base, recurrence }).ok, `served refuses ${label}`).toBe(false)
  })

  test("every recurrence the wire accepts, the engine can run", () => {
    const neverFires: string[] = []
    for (const { label, recurrence } of RUNNABLE) {
      const decoded = Schema.decodeUnknownSync(WireCreateInput)({ ...base, recurrence })
      // No cast: the wire's decoded type IS the engine's `Recurrence`.
      const fire = Recurrence.nextFire(decoded.recurrence, AFTER, decoded.tzOffsetMin ?? 0)
      if (fire === null || !Number.isFinite(fire) || fire <= AFTER) neverFires.push(`${label} -> ${fire}`)
    }
    expect(neverFires).toEqual([])
  })

  test("a recurrence the engine cannot run is refused, and the refusal names the field", () => {
    const accepted: string[] = []
    const unnamed: string[] = []
    for (const { label, recurrence, names } of UNRUNNABLE) {
      const result = decode(WireRecurrence, recurrence)
      if (result.ok) accepted.push(label)
      else if (!result.message.includes(names)) unnamed.push(`${label} -> ${result.message}`)
    }
    expect(accepted).toEqual([])
    expect(unnamed).toEqual([])
  })

  test("the values the wire refuses are the ones the engine could not have run", () => {
    // The mirror of the join above, and the half that makes it a real control rather than a
    // one-sided ratchet: a schema that refused EVERYTHING would satisfy the refusal test alone.
    // Every case below is fed to the engine as a raw value, and the engine's own answer is the
    // reason the wire refuses it.
    const enginesVerdict = [
      Recurrence.nextFire({ kind: "weekly", time: at(9, 0), weekdays: [7 as never] }, AFTER),
      Recurrence.nextFire({ kind: "weekly", time: at(9, 0), weekdays: [] }, AFTER),
      Recurrence.nextFire({ kind: "monthly", time: at(9, 0), day: 0 }, AFTER),
      Recurrence.nextFire({ kind: "once", at: Number.NaN }, AFTER),
      Recurrence.nextFire({ kind: "daily", time: at(Number.NaN, 0) }, AFTER),
    ]
    expect(enginesVerdict).toEqual([null, null, null, null, null])
  })

  test("an out-of-domain timezone offset is refused too", () => {
    // `tzOffsetMin` is the other input `nextFire` does arithmetic with: a non-finite offset makes
    // every candidate instant NaN, so the schedule never becomes due.
    expect(
      decode(WireCreateInput, { ...base, tzOffsetMin: "NaN", recurrence: { kind: "daily", time: at(9, 0) } }).ok,
    ).toBe(false)
    expect(
      decode(WireCreateInput, { ...base, tzOffsetMin: 99_999, recurrence: { kind: "daily", time: at(9, 0) } }).ok,
    ).toBe(false)
    expect(
      decode(WireCreateInput, { ...base, tzOffsetMin: -720, recurrence: { kind: "daily", time: at(9, 0) } }).ok,
    ).toBe(true)
  })
})

/**
 * ─── ONE PERMISSION VOCABULARY, IN BOTH DIRECTIONS ───────────────────────────────────────────────
 *
 * `CreateInput.permissionMode` was narrowed to the kernel's literal set; the `Schedule` every read
 * endpoint returns still declared `Schema.NullOr(Schema.String)`. A decode guarantee has a
 * DIRECTION, and that one existed only on the way in: a generated client could not assign a fetched
 * `Schedule.permissionMode` to `CreateInput.permissionMode`, so round-tripping a schedule through
 * PATCH did not typecheck, and the scheduler was left blind-casting the stored string into the union
 * it switches on.
 */
const SCHEDULE_ROW = {
  id: "sch_1",
  title: "Morning report",
  recurrence: { kind: "daily", time: at(9, 0) },
  tzOffsetMin: 60,
  prompt: "write the morning report",
  agent: null,
  model: null,
  location: null,
  permissionMode: null as string | null,
  enabled: true,
  nextFireAt: null,
  lastFiredAt: null,
  timeCreated: 1,
  timeUpdated: 2,
}

describe("the calendar wire's permission vocabulary", () => {
  test("the union is not empty and is the kernel's own", () => {
    // Guards the shape of the two loops below: over an empty list they would assert nothing.
    expect([...PermissionMode.literals].sort()).toEqual(["ask", "bypass", "plan", "surgical", "yolo"])
  })

  test("every mode the kernel accepts is accepted in both directions", () => {
    const rejected: string[] = []
    for (const mode of PermissionMode.literals) {
      if (!decode(WireCreateInput, { ...base, recurrence: { kind: "daily", time: at(9, 0) }, permissionMode: mode }).ok)
        rejected.push(`inbound ${mode}`)
      if (!decode(WireSchedule, { ...SCHEDULE_ROW, permissionMode: mode }).ok) rejected.push(`outbound ${mode}`)
    }
    expect(rejected).toEqual([])
    expect(decode(WireSchedule, { ...SCHEDULE_ROW, permissionMode: null }).ok).toBe(true)
  })

  test("a mode outside the union is refused in both directions", () => {
    const outside = ["", "admin", "Plan", "bypass ", "readonly"]
    const accepted: string[] = []
    for (const mode of outside) {
      if (decode(WireCreateInput, { ...base, recurrence: { kind: "daily", time: at(9, 0) }, permissionMode: mode }).ok)
        accepted.push(`inbound ${JSON.stringify(mode)}`)
      if (decode(WireSchedule, { ...SCHEDULE_ROW, permissionMode: mode }).ok)
        accepted.push(`outbound ${JSON.stringify(mode)}`)
    }
    expect(accepted).toEqual([])
  })

  test("the served response schema carries the union, not a bare string", () => {
    expect(decode(servedCreateSuccess!, { ...SCHEDULE_ROW, permissionMode: "plan" }).ok).toBe(true)
    expect(decode(servedCreateSuccess!, { ...SCHEDULE_ROW, permissionMode: "admin" }).ok).toBe(false)
  })
})
