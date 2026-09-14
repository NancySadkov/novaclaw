import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const activity = readFileSync(new URL("./session-activity-indicators.tsx", import.meta.url), "utf8")
const composer = readFileSync(new URL("../prompt-input.tsx", import.meta.url), "utf8")
const workerDialog = readFileSync(new URL("../worker-list-dialog.tsx", import.meta.url), "utf8")

test("activity shortcuts render only for non-empty worker and shell lists", () => {
  expect(activity).toContain("<Show when={workers().length > 0}>")
  expect(activity).toContain("<Show when={shells().length > 0}>")
})

test("both activity shortcuts open list dialogs from authoritative live stores", () => {
  expect(activity).toContain("workersOf(sync().data.session")
  expect(activity).toContain("client.v2.session.bash.list")
  expect(activity.match(/dialog\.showScoped/g)).toHaveLength(2)
})

test("a worker stop requires a reason and sends it through the execution API", () => {
  expect(activity).toContain("stopSessionExecution(current.http, worker.id, sdk().directory, reason)")
  expect(workerDialog).toContain('language.t("contacts.workers.stopReason")')
  expect(workerDialog).toContain("disabled={!reason().trim() || saving()}")
  expect(workerDialog).toContain("await props.onStop(worker, why)")
})

test("activity shortcuts sit after the project control and before the context gauge", () => {
  const controls = composer.indexOf("<ComposerControlsRow")
  const activityIndicators = composer.indexOf("<SessionActivityIndicators")
  const contextGauge = composer.lastIndexOf("<SessionContextUsage")
  expect(controls).toBeGreaterThan(-1)
  expect(activityIndicators).toBeGreaterThan(controls)
  expect(contextGauge).toBeGreaterThan(activityIndicators)
})
