import { expect, test } from "bun:test"
import { Effect } from "effect"
import { CredentialRepair as Repair } from "./repair"

const source = (
  rows: ReadonlyArray<{ path: string; value: unknown }>,
  readable = true,
  listable = true,
): Repair.ScanSource => ({
  name: "fixture-store",
  rows: () => (listable ? Effect.succeed(rows) : Effect.die(new Error("table is gone"))),
  validate: () => (readable ? Effect.void : Effect.fail(new Error("invalid stored value"))),
})

test("an empty source has no unreadable secrets", () => {
  expect(Effect.runSync(Repair.scanSource(source([], false)))).toEqual([])
})
test("an invalid stored value is reported by path", () => {
  expect(Effect.runSync(Repair.scanSource(source([{ path: "credential:one", value: "bad" }], false)))).toEqual([
    { path: "credential:one" },
  ])
})
test("a readable value is not reported", () => {
  expect(Effect.runSync(Repair.scanSource(source([{ path: "a", value: "valid" }])))).toEqual([])
})
test("a source that cannot be listed reports an unknown store instead of healthy", () => {
  expect(Effect.runSync(Repair.scanSource(source([], true, false)))).toEqual([{ path: "fixture-store" }])
})
test("one failed source does not hide another source's findings", () => {
  expect(Effect.runSync(Repair.scan([source([], true, false), source([{ path: "b", value: "bad" }], false)]))).toEqual([
    { path: "fixture-store" },
    { path: "b" },
  ])
})
test("the same path through two sources is counted once", () => {
  const row = { path: "a", value: "bad" }
  expect(Effect.runSync(Repair.scan([source([row], false), source([row], false)]))).toEqual([{ path: "a" }])
})
test("a healthy instance produces no notice", () => {
  expect(Repair.notice([])).toBeUndefined()
})
test("the notice gives supported account and identity repair paths", () => {
  const message = Repair.notice([{ path: "credential:one" }])!
  expect(message).toContain("1 stored secret")
  expect(message).toContain("Reconnect")
  expect(message).toContain("identity backup in Community settings")
})
test("the count is plural when it should be", () => {
  expect(Repair.notice([{ path: "a" }, { path: "b" }])).toContain("2 stored secrets")
})
test("the notice never carries stored bytes", () => {
  expect(Repair.notice([{ path: "credential:private-id" }])).not.toContain("private-id")
})
