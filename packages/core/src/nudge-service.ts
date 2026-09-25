export * as NudgeService from "./nudge-service"

import { and, desc, eq, ne } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { createHash } from "node:crypto"
import { Log } from "@novaclaw/schema/log"
import { AgentConfigStore } from "./agent-config-store"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { HostExec } from "./host-exec"
import { JhProcessRunner } from "./jh/process-runner"
import { ConfigNudge } from "./config/nudge"
import { Nudge } from "./nudge"
import { SessionOrigin } from "./session/origin"
import { SessionSchema } from "./session/schema"
import { SessionCompactionTable } from "./session/sql"
import { NudgeDeliveryTable } from "./nudge-delivery.sql"
import { SessionInput } from "./session/input"
import { SessionMessage } from "./session/message"
import { Shell } from "./shell"

export interface Interface {
  readonly beforeTool: (input: { readonly sessionID: string; readonly agentID: string; readonly callID: string; readonly name: string; readonly arguments: unknown; readonly directory?: string }) => Effect.Effect<string | undefined>
  readonly confirmBefore: (input: { readonly sessionID: string; readonly agentID: string; readonly id: string; readonly callID: string }) => Effect.Effect<boolean>
  readonly deliverScheduled: (input: {
    readonly sessionID: string
    readonly sessionEpoch: number
    readonly scheduleID: string
    readonly occurrence: string
    readonly text: string
    readonly admittedAt: number
    readonly admit: (messageID: SessionMessage.ID, text: string) => Effect.Effect<string, unknown>
  }) => Effect.Effect<void, unknown>
  /** Select applicable definitions (shipped defaults plus the owning officer's own list),
   *  and atomically claim each new occurrence for this session. A claimed match is safe to
   *  lower through SessionInput.steer once. */
  readonly claim: (input: {
    readonly sessionID: string
    readonly agentID?: string
    readonly directory: string
    readonly event: Nudge.Event
  }) => Effect.Effect<ReadonlyArray<ConfigNudge.Info>>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/NudgeService") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const agents = yield* AgentConfigStore.Service
    const runner = JhProcessRunner.plannedRunner({
      maxOutputBytes: 16_384,
      plan: ({ command, cwd }) =>
        HostExec.spawnPlan({
          shape: { kind: "shell-command", shell: process.platform === "win32" ? (Shell.w64devkitShell() ?? HostExec.resolveShell()) : HostExec.resolveShell(), command },
          cwd,
          worktree: cwd,
          consent: "none",
        }),
    })
    const runScript = (command: string, directory: string) => runner.run({ command, cwd: directory, timeoutMs: 5_000 })
    const renderInline = Effect.fn("NudgeService.renderInline")(function* (source: string, directory: string) {
      let text = source.trim()
      let count = 0
      for (const match of source.matchAll(/\$\(([^()\r\n]+)\)/g)) {
        count++
        if (count > 4 || match[1]!.length > 512) {
          text = text.replace(match[0], "[inline command omitted: limit reached]")
          continue
        }
        const result = yield* runScript(match[1]!, directory)
        if (result.exitCode !== 0 || result.timedOut) {
          text = text.replace(match[0], "[command failed]")
          continue
        }
        const output = result.output.trim().slice(0, 1_024)
        const trustedDate = /^date(?:\s|$)/.test(match[1]!.trim()) && /^\d{4}-\d{2}-\d{2} [A-Za-z]+$/.test(output)
        text = text.replace(match[0], trustedDate
          ? output
          : `${SessionOrigin.externalContentFrame("configured nudge inline command output")}${output}`)
      }
      return text
    })
    const pending = new Map<string, { callID: string; signature: string; confirmed: boolean; at: number }>()
    const pendingKey = (sessionID: string, agentID: string, id: string) => `${sessionID}\u0000${agentID}\u0000${id}`
    /** What this session was last told about this nudge, if anything. */
    const priorDelivery = (sessionID: string, deliveryID: string) =>
      db
        .select({ occurrence: NudgeDeliveryTable.occurrence, firedAt: NudgeDeliveryTable.fired_at })
        .from(NudgeDeliveryTable)
        .where(and(eq(NudgeDeliveryTable.session_id, sessionID), eq(NudgeDeliveryTable.nudge_id, deliveryID)))
        .get()
        .pipe(Effect.orDie)
    return Service.of({
      beforeTool: Effect.fn("NudgeService.beforeTool")(function* (input) {
        const agent = AgentConfigStore.fold((yield* agents.configured())[input.agentID] ?? [])
        const event: Nudge.Event = { type: "tool", phase: "before", id: input.callID, name: input.name, input: input.arguments }
        const matched = (agent?.nudges ?? []).filter((nudge) =>
          (nudge.hook.type === "tool-call" || nudge.hook.type === "shell-command") && nudge.hook.phase === "before" && Nudge.matches(nudge, event))
        const signature = JSON.stringify([input.name, input.arguments])
        const now = Date.now()
        const waiting = matched.find((nudge) => {
          const key = pendingKey(input.sessionID, input.agentID, nudge.id)
          const prior = pending.get(key)
          return !(prior?.confirmed && prior.signature === signature && now - prior.at < 10 * 60_000)
        })
        if (waiting) {
          const key = pendingKey(input.sessionID, input.agentID, waiting.id)
          pending.set(key, { callID: input.callID, signature, confirmed: false, at: now })
          const rendered = yield* renderInline(waiting.text, input.directory ?? process.cwd())
          return `${Nudge.prompt({ ...waiting, text: rendered })}\nThis call was blocked before execution. Find nudge with tool_search if needed, then call nudge({"op":"confirm","id":${JSON.stringify(waiting.id)},"callId":${JSON.stringify(input.callID)}}) and retry the same call.`
        }
        for (const nudge of matched) pending.delete(pendingKey(input.sessionID, input.agentID, nudge.id))
        return undefined
      }),
      confirmBefore: Effect.fn("NudgeService.confirmBefore")(function* (input) {
        const key = pendingKey(input.sessionID, input.agentID, input.id)
        const item = pending.get(key)
        if (!item || item.callID !== input.callID || Date.now() - item.at >= 10 * 60_000) return false
        pending.set(key, { ...item, confirmed: true })
        return true
      }),
      deliverScheduled: Effect.fn("NudgeService.deliverScheduled")(function* (input) {
        const messageID = SessionMessage.ID.make("msg_" + createHash("sha256")
          .update(`${input.sessionID}:${input.sessionEpoch}:${input.scheduleID}:${input.occurrence}`)
          .digest("hex").slice(0, 32))
        const admittedSessionID = yield* input.admit(messageID, SessionInput.applySteerProvenance(input.text))
        yield* db.insert(NudgeDeliveryTable).values({
          session_id: admittedSessionID,
          nudge_id: `schedule:${input.scheduleID}`,
          occurrence: input.occurrence,
          fired_at: input.admittedAt,
        }).onConflictDoUpdate({
          target: [NudgeDeliveryTable.session_id, NudgeDeliveryTable.nudge_id],
          set: { occurrence: input.occurrence, fired_at: input.admittedAt },
          setWhere: ne(NudgeDeliveryTable.occurrence, input.occurrence),
        }).run().pipe(Effect.orDie)
      }),
      claim: Effect.fn("NudgeService.claim")(function* (input) {
        // One read per event, not per definition: the quiet rule asks whether the context this nudge
        // was delivered into still exists, and a session has at most one answer to that.
        const compacted = yield* db
          .select({ at: SessionCompactionTable.time_created })
          .from(SessionCompactionTable)
          .where(eq(SessionCompactionTable.session_id, input.sessionID as SessionSchema.ID))
          .orderBy(desc(SessionCompactionTable.seq))
          .limit(1)
          .get()
          .pipe(Effect.orDie)
        let suppressed = 0
        const agent =
          input.agentID === undefined ? undefined : AgentConfigStore.fold((yield* agents.configured())[input.agentID] ?? [])
        const definitions: Nudge.ScopedDefinition[] = [
          ...(input.agentID === undefined
            ? []
            : (agent?.nudges ?? []).map((nudge) => ({
                nudge,
                deliveryID: `agent:${input.agentID}:${nudge.id}`,
              }))),
        ]
        const claimed: ConfigNudge.Info[] = []
        for (const scoped of definitions) {
          if (!Nudge.matches(scoped.nudge, input.event)) continue
          let occurrence = Nudge.occurrenceFor(scoped.nudge, input.event)
          // The interval cap is tested BEFORE any hook runs: saying "quiet" must not itself cost a
          // command execution on the way to the answer.
          const prior = yield* priorDelivery(input.sessionID, scoped.deliveryID)
          if (prior && !Nudge.periodic(occurrence) && scoped.nudge.spammable !== true && Date.now() - prior.firedAt < Nudge.QUIET_INTERVAL_MS) {
            suppressed++
            continue
          }
          let hookOutput = ""
          if (scoped.nudge.hook.type === "script") {
            const result = yield* runScript(scoped.nudge.hook.command, input.directory)
            if (result.exitCode !== 0 || result.timedOut) continue
            hookOutput = result.output.trim()
            occurrence = `script:${createHash("sha256").update(hookOutput).digest("hex")}`
          }
          const now = Date.now()
          // The occurrence is final now (a script hook rewrote it), so the full rule can be answered.
          if (
            prior &&
            !Nudge.deliverable({
              prior,
              occurrence,
              spammable: scoped.nudge.spammable === true,
              now,
              compactedAfter: compacted !== undefined && compacted.at > prior.firedAt,
            })
          ) {
            suppressed++
            continue
          }
          if (scoped.nudge.hook.type === "new-day") {
            const seeded = yield* db
              .insert(NudgeDeliveryTable)
              .values({
                session_id: input.sessionID,
                nudge_id: scoped.deliveryID,
                occurrence,
                // 🔴 `0`, not `now`: this row is a BASELINE, and nothing was delivered. Writing the
                // current time here would tell the quiet rule that a delivery happened just now, and
                // the midnight notice would then be held back for half an hour by an event that never
                // fired. The day-change claim below overwrites it with a real timestamp.
                fired_at: 0,
              })
              .onConflictDoNothing()
              .returning({ occurrence: NudgeDeliveryTable.occurrence })
              .get()
              .pipe(Effect.orDie)
            // Establishing today's baseline is not a calendar transition. The first actual change
            // updates the row below and delivers the Nudge once.
            if (seeded) continue
          }
          const rendered = scoped.nudge.script?.trim()
            ? yield* runScript(scoped.nudge.script, input.directory)
            : undefined
          const dynamic = rendered?.exitCode === 0 && !rendered.timedOut ? rendered.output.trim() : ""
          const filePathToken = "\uFFF0absolute_file_path\uFFF1"
          const source =
            input.event.type === "file-edit"
              ? scoped.nudge.text.replaceAll("$(absolute_file_path)", filePathToken)
              : scoped.nudge.text
          const interpolated = (yield* renderInline(source, input.directory)).replaceAll(
            filePathToken,
            input.event.type === "file-edit" ? input.event.path.replace(/[\r\n\t]/g, " ") : filePathToken,
          )
          const text = [
            interpolated,
            hookOutput ? SessionOrigin.externalContentFrame("configured nudge hook output") + hookOutput : "",
            dynamic ? SessionOrigin.externalContentFrame("configured nudge script output") + dynamic : "",
          ]
            .filter(Boolean)
            .join("\n")
          if (!text) continue
          const recorded = yield* db
            .insert(NudgeDeliveryTable)
            .values({
              session_id: input.sessionID,
              nudge_id: scoped.deliveryID,
              occurrence,
              fired_at: now,
            })
            .onConflictDoUpdate({
              target: [NudgeDeliveryTable.session_id, NudgeDeliveryTable.nudge_id],
              set: { occurrence, fired_at: now },
              setWhere: ne(NudgeDeliveryTable.occurrence, occurrence),
            })
            .returning({ occurrence: NudgeDeliveryTable.occurrence })
            .get()
            .pipe(Effect.orDie)
          if (!recorded) continue
          claimed.push({ ...scoped.nudge, text })
        }
        // Suppression is the interesting half of this feature and it is invisible by construction:
        // a quiet nudge leaves no trace in the transcript. Without this line, "the rule is working"
        // and "the nudge stopped matching" are the same observation.
        if (suppressed > 0)
          yield* Log.event("session.nudge.quiet", {
            "session.id": input.sessionID,
            "nudge.suppressed": suppressed,
          })
        return claimed
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Database.defaultLayer),
  Layer.provide(AgentConfigStore.defaultLayer),
)
export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, AgentConfigStore.node],
})
