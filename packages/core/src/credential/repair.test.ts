import { expect, test } from "bun:test"
import { Effect } from "effect"
import { CredentialRepair as Repair } from "./repair"

const source = (
  rows: ReadonlyArray<{ path: string; value: unknown }>,
  openable: (path: string) => boolean,
  listable = true,
): Repair.ScanSource => ({
  rows: () => (listable ? Effect.succeed(rows) : Effect.die(new Error("table is gone"))),
  sealed: (value) => typeof value === "string" && value.startsWith("sealed:"),
  open: (path) => (openable(path) ? Effect.succeed("plaintext") : Effect.fail(new Error("no key"))),
})

test("only SEALED values are candidates — a plaintext row is not a fault", () => {
  // The unwind writes plaintext back as envelopes are opened, so most rows are expected to be plain.
  // Reporting those would make a healthy instance mid-drain look broken.
  expect(Effect.runSync(Repair.scanSource(source([{ path: "a", value: "plain" }], () => false)))).toEqual([])
})

test("a sealed value that will not open is reported by path", () => {
  expect(
    Effect.runSync(Repair.scanSource(source([{ path: "credential:anthropic", value: "sealed:x" }], () => false))),
  ).toEqual([{ path: "credential:anthropic" }])
})

test("a sealed value that DOES open is not reported", () => {
  expect(Effect.runSync(Repair.scanSource(source([{ path: "a", value: "sealed:x" }], () => true)))).toEqual([])
})

test("🔴 a source that cannot even be LISTED contributes nothing instead of failing the scan", () => {
  /**
   * This runs to tell a user something is broken, against exactly the stores that may be damaged. A
   * scan that dies when one of them does becomes a second broken thing and reports nothing at all.
   *
   * A/B: drop the outer `catchCause` in `scanSource` and this throws.
   */
  expect(Effect.runSync(Repair.scanSource(source([{ path: "a", value: "sealed:x" }], () => false, false)))).toEqual([])
})

test("🔴 one damaged source does not hide another source's findings", () => {
  const found = Effect.runSync(
    Repair.scan([
      source([{ path: "a", value: "sealed:x" }], () => false, false),
      source([{ path: "b", value: "sealed:x" }], () => false),
    ]),
  )
  expect(found).toEqual([{ path: "b" }])
})

test("🔴 the same path through two stores is counted ONCE", () => {
  // The cipher unwind moves rows between stores, so overlap is expected. Double-counting overstates
  // the damage in the one message a user reads to decide whether to restore a backup.
  const found = Effect.runSync(
    Repair.scan([
      source([{ path: "a", value: "sealed:x" }], () => false),
      source([{ path: "a", value: "sealed:x" }], () => false),
    ]),
  )
  expect(found).toHaveLength(1)
})

test("a healthy instance produces NO notice, so the surface can ask unconditionally", () => {
  expect(Repair.notice([], "C:/data")).toBeUndefined()
})

test("🔴 the notice names the FILE and the directory, not just the symptom", () => {
  /**
   * "Some credentials could not be read" leaves the user nowhere to go. The entire repair is
   * restoring one file, and a message that does not name it makes a fixable state look like data
   * loss.
   */
  const message = Repair.notice([{ path: "credential:anthropic" }], "C:/data")!
  expect(message).toContain("credential.key")
  expect(message).toContain("C:/data")
  expect(message).toContain("1 stored secret")
})

test("the count is plural when it should be", () => {
  expect(Repair.notice([{ path: "a" }, { path: "b" }], "d")).toContain("2 stored secrets")
})

test("🔴 the notice never carries a stored VALUE", () => {
  // Sealed bytes are unreadable here by construction, but the day this runs against something
  // readable a value-quoting message would leak it. Paths only.
  expect(Repair.notice([{ path: "credential:anthropic" }], "C:/data")).not.toContain("sealed:")
})
