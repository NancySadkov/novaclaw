import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const activity = readFileSync(new URL("./session-activity-indicators.tsx", import.meta.url), "utf8")
const composer = readFileSync(new URL("../prompt-input.tsx", import.meta.url), "utf8")
const teamChat = readFileSync(new URL("../team-chat-button.tsx", import.meta.url), "utf8")
const teamChatDialog = readFileSync(new URL("../team-chat-dialog.tsx", import.meta.url), "utf8")
const workerDialog = readFileSync(new URL("../worker-list-dialog.tsx", import.meta.url), "utf8")
const shellDialog = readFileSync(new URL("../shell-list-dialog.tsx", import.meta.url), "utf8")

test("activity shortcuts render only for non-empty worker and shell lists", () => {
  expect(activity).toContain("<Show when={workers().length > 0}>")
  expect(activity).toContain("<Show when={shells().length > 0}>")
})

test("both activity shortcuts open list dialogs from authoritative live stores", () => {
  expect(activity).toContain("useWorkers(() => props.sessionID)")
  expect(activity).toContain("client.v2.session.bash.list")
  expect(activity.match(/dialog\.showScoped/g)).toHaveLength(2)
})

test("a restart-empty browser cache cannot hide durable workers from the prompt", () => {
  expect(activity).not.toContain("workersOf(sync().data.session")
  expect(activity).toContain("useWorkers(() => props.sessionID)")
  expect(activity).toContain("const workers = createMemo(() => workerQuery.data ?? [])")
})

test("a worker stop requires a reason and sends it through the execution API", () => {
  expect(activity).toContain("stopSessionExecution(current.http, worker.id, sdk().directory, reason)")
  expect(workerDialog).toContain('language.t("contacts.workers.stopReason")')
  expect(workerDialog).toContain("disabled={!reason().trim() || saving()}")
  expect(workerDialog).toContain("await props.onStop(worker, why)")
})

test("a shell stop requires a reason and addresses the job id, not the tool call", () => {
  expect(activity).toContain("stopSessionCommand(current.http, job.sessionID, sdk().directory, job.id, reason)")
  expect(shellDialog).toContain('language.t("session.activity.shells.stopReason")')
  expect(shellDialog).toContain("disabled={!reason().trim() || saving()}")
  expect(shellDialog).toContain("await props.onStop(job, why)")
})

test("both activity dialogs show elapsed time since launch", () => {
  expect(shellDialog).toContain("RunningFor")
  expect(workerDialog).toContain("RunningFor")
})

test("both activity dialogs are fed live accessors so finished work drops out", () => {
  expect(activity).toContain("workers={workers()}")
  expect(activity).toContain("shells={shells()}")
})

test("activity shortcuts sit after the context gauge", () => {
  const controls = composer.indexOf("<ComposerControlsRow")
  const activityIndicators = composer.indexOf("<SessionActivityIndicators")
  const contextGauge = composer.lastIndexOf("<SessionContextUsage")
  const teamChatButton = composer.indexOf("<TeamChatButton")
  expect(controls).toBeGreaterThan(-1)
  expect(teamChatButton).toBeGreaterThan(contextGauge)
  expect(activityIndicators).toBeGreaterThan(teamChatButton)
  expect(activityIndicators).toBeGreaterThan(controls)
  expect(activityIndicators).toBeGreaterThan(contextGauge)
})

test("Team Chat is officer-only and reads the live durable team projection", () => {
  expect(teamChat).toContain("if (!info?.agent || info.parentID) return")
  expect(teamChat).toContain('kind === "chat" || kind === "human"')
  expect(teamChat).toContain('data-action="team-chat"')
  expect(teamChatDialog).toContain("client.v2.agent.teamChat")
  expect(teamChatDialog).toContain("refetchInterval: 2_000")
  expect(teamChatDialog).toContain("<AgentPortrait")
  expect(teamChatDialog).toContain('limit: "50", before')
  expect(teamChatDialog).toContain("after: latestCursor()")
  expect(teamChatDialog).toContain("setOlderFailed(true)")
  expect(teamChatDialog).toContain("tailQuery.isError && messages().length > 0")
  expect(teamChatDialog).toContain("captureTeamChatScrollAnchor(scroller)")
  expect(teamChatDialog).toContain("restoreTeamChatScrollAnchor(scroller, anchor)")
  const tailEffect = teamChatDialog.slice(teamChatDialog.indexOf("const page = tailQuery.data"))
  expect(tailEffect.indexOf("setLatestCursor(page.cursor.latest)")).toBeLessThan(
    tailEffect.indexOf("page.data.length === 0"),
  )
  expect(teamChatDialog).toContain("h-[min(82dvh,42rem)]")
  expect(teamChatDialog).not.toContain("min-h-[24rem]")
})
