import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionComponentRegistry } from "@novaclaw/core/session/component-registry"
import { SESSION_CONFIG_FIELDS } from "@novaclaw/core/session/config-resolve"
import { SessionFeature } from "@novaclaw/schema/session-feature"

/**
 * The `tuning` component: the composer's Tuning panel, reachable as one component value.
 *
 * The switch names now exist in THREE places that must agree — `SessionFeature.Name` (the kernel's
 * canonical union), the `Tuning` codec (literal keys, so the schema stays precisely typed) and the
 * registry's column map (real Drizzle column objects, which cannot be derived). Neither of the last
 * two can be generated from the first, so the agreement is pinned here instead of hoped for.
 */

const codecKeys = Object.keys(SessionComponentRegistry.Tuning.fields).sort()

describe("the tuning component's key set", () => {
  test("the codec covers exactly the canonical feature union", () => {
    expect(codecKeys).toEqual([...SessionFeature.Name.literals].sort())
  })

  test("every switch is a real session config component with a column", () => {
    // A key in the codec that is not a config field would accept a write and then have nowhere to
    // put it — the projector writes one column per `FeatureSwitched` event.
    for (const name of codecKeys) {
      const field = SESSION_CONFIG_FIELDS[name as keyof typeof SESSION_CONFIG_FIELDS]
      expect(field, `${name} is in the tuning codec but is not a session config field`).toBeDefined()
      expect(field.column, `${name} has no column to project onto`).toBeTruthy()
    }
  })

  test("🔴 every switch is OPTIONAL — absent means inherit, never off", () => {
    // The tri-state is the whole contract (`session-feature.ts`). A required key would turn "I have
    // not decided" into "I decided no" for every switch an agent left out of one write.
    const fields = SessionComponentRegistry.Tuning.fields as Record<string, unknown>
    for (const name of codecKeys) {
      const decoded = Schema.decodeUnknownResult(SessionComponentRegistry.Tuning)({ [name]: true })
      expect(decoded._tag, `${name} could not be written on its own`).toBe("Success")
      expect(fields[name]).toBeDefined()
    }
    // …and the empty value decodes, which is what "no stance at all" has to look like on the wire.
    expect(Schema.decodeUnknownResult(SessionComponentRegistry.Tuning)({})._tag).toBe("Success")
  })

  test("a non-boolean stance is refused", () => {
    // Guards the tri-state from becoming a four-state: "inherit" is the ABSENCE of a key, never a
    // string or a null sitting in one.
    for (const bad of [{ safeMode: "on" }, { safeMode: 1 }, { safeMode: null }]) {
      expect(Schema.decodeUnknownResult(SessionComponentRegistry.Tuning)(bad)._tag).toBe("Failure")
    }
  })

  test("⚠️ an unknown switch is ACCEPTED and dropped — registry-wide, and a known defect", () => {
    // Measured, not intended. `decodeInput` calls `Schema.decodeUnknownEffect(codec)` with no
    // `onExcessProperty`, so Effect's default (ignore) applies to EVERY struct-codec component: a
    // write of `{safeMod: true}` — a typo — reports success and changes nothing, which is ruling 2's
    // failed-mutation-reporting-success. Pinned here so the day someone tightens the registry this
    // test fails and points at the decision rather than at a mystery.
    // todo/ecs.md owns it; not fixed here because the option is registry-wide and every component's
    // callers would have to be checked first.
    const decoded = Schema.decodeUnknownResult(SessionComponentRegistry.Tuning)({ notASwitch: true })
    expect(decoded._tag).toBe("Success")
  })
})

describe("the tuning component is declared", () => {
  test("`tuning` is a kernel kind and is no longer only a reserved name", () => {
    expect(SessionComponentRegistry.KERNEL_KIND_NAMES).toContain("tuning")
    expect(SessionComponentRegistry.Tuning).toBeDefined()
  })

  test("the panel's ten switches all reach it", () => {
    // The composer renders nine of these (thinkingBudget moved to Settings → Models), but the
    // component carries all ten because the kernel accepts all ten.
    expect(codecKeys.length).toBe(10)
  })
})
