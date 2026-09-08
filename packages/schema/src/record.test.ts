import { expect, test } from "bun:test"
import { isRecord } from "./record"

/**
 * . Twelve hand-rolled copies of this predicate collapsed onto one export, so the shape
 * table they collectively implied is pinned here rather than re-derived by the next reader.
 */

class Thing {
  constructor(public a = 1) {}
}

/** Everything the merged sites can be handed, with the answer the merged predicate owes. */
const TABLE: ReadonlyArray<readonly [label: string, value: unknown, record: boolean]> = [
  // ── the reason the array guard exists ───────────────────────────────────────────────────────
  ["[]", [], false],
  ["[1,2]", [1, 2], false],
  // ── the reason `value !== null` exists ──────────────────────────────────────────────────────
  ["null", null, false],
  ["undefined", undefined, false],
  // ── primitives ──────────────────────────────────────────────────────────────────────────────
  ["0", 0, false],
  ["NaN", Number.NaN, false],
  ["''", "", false],
  ["'x'", "x", false],
  ["false", false, false],
  ["true", true, false],
  ["0n", 0n, false],
  ["Symbol()", Symbol("s"), false],
  ["() => {}", () => {}, false],
  ["class ctor", Thing, false],
  // ── plain records ───────────────────────────────────────────────────────────────────────────
  ["{}", {}, true],
  ["{a:1}", { a: 1 }, true],
  ["Object.create(null)", Object.create(null) as unknown, true],
  ["JSON.parse('{}')", JSON.parse("{}") as unknown, true],
  // 🔴 The LOOSE half of the contract. These are records to this predicate ON PURPOSE — the
  // question it answers is "can I index this with a string key?", not "is this a literal {}?".
  ["new Date()", new Date(), true],
  ["new Map()", new Map(), true],
  ["new Set()", new Set(), true],
  ["/re/", /re/, true],
  ["Promise", Promise.resolve(), true],
  ["ArrayBuffer", new ArrayBuffer(8), true],
  ["Uint8Array", new Uint8Array(2), true],
  ["Error", new Error("x"), true],
  ["class instance", new Thing(), true],
  // ── the boxed primitives the falsified "!!value" divergence was supposed to separate ─────────
  ["new Boolean(false)", new Boolean(false), true],
  ["new Number(0)", new Number(0), true],
  ["new String('')", new String(""), true],
]

test("the merged predicate answers every shape the twelve sites could be handed", () => {
  for (const [label, value, expected] of TABLE) {
    expect(`${label}=${isRecord(value)}`).toBe(`${label}=${expected}`)
  }
})

test("🔴 the `!!value` vs `value !== null` divergence  was filed over does not exist", () => {
  // The A/B, run rather than asserted in prose. `app/src/utils/diffs.ts` and the pre-2026-09-01
  // `novaclaw/src/util/record.ts` used the `!!value` form; everything else used `value !== null`.
  // If they could differ, the separating value would be a FALSY object — and `null` is the only
  // one, which both reject. The boxed primitives above are the shapes people reach for expecting
  // otherwise; they are all truthy.
  const truthyForm = (value: unknown): boolean => !!value && typeof value === "object" && !Array.isArray(value)
  for (const [label, value] of TABLE) {
    expect(`${label}=${truthyForm(value)}`).toBe(`${label}=${isRecord(value)}`)
  }
})

test("🔴 the stricter PROTOTYPE contract is a different question, and the table proves it", () => {
  // The control that stops a future session folding `core/src/observability/logging.ts` in here.
  // If this ever stops disagreeing, one of the two predicates has been quietly changed.
  const plain = (input: unknown): boolean => {
    if (input === null || typeof input !== "object" || Array.isArray(input)) return false
    const prototype = Object.getPrototypeOf(input)
    return prototype === Object.prototype || prototype === null
  }
  const disagreements = TABLE.filter(([, value]) => plain(value) !== isRecord(value)).map(([label]) => label)
  expect(disagreements).toEqual([
    "new Date()",
    "new Map()",
    "new Set()",
    "/re/",
    "Promise",
    "ArrayBuffer",
    "Uint8Array",
    "Error",
    "class instance",
    "new Boolean(false)",
    "new Number(0)",
    "new String('')",
  ])
})

test("🔴 the array guard is load-bearing — `app/src/addons/serialize.ts` omits it on purpose", () => {
  // The control that stops the reverse fold: serialize.ts's copy stays a copy because an array
  // narrows to Record there and a duck-typed isBuffer check catches it. Merging it would CHANGE
  // behaviour, not de-duplicate it.
  const withoutArrayGuard = (value: unknown): boolean => typeof value === "object" && value !== null
  expect(withoutArrayGuard([])).toBe(true)
  expect(isRecord([])).toBe(false)
})

test("a narrowed record is indexable without a cast", () => {
  // The predicate's whole point is the narrowing, so exercise it rather than the boolean.
  const value: unknown = { a: 1, b: "two" }
  if (!isRecord(value)) throw new Error("unreachable")
  expect(value.a).toBe(1)
  expect(value.b).toBe("two")
  expect(value.missing).toBeUndefined()
})
