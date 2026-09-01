import { For, Show, type Component } from "solid-js"
import { useLanguage } from "@/context/language"
import type { ShellStatus } from "@/utils/fs-api"
// No `SettingsListV2` here any more: these rows are rendered INSIDE the health report's list, not in
// a list of their own (see `ConfinementRows` below for why).
import { SettingsRowV2 } from "./parts/row"
import { SettingsExplainV2 } from "./explain"
// ⚠️ TYPE-ONLY. `@novaclaw/core/agent-jail` imports `node:child_process` at module scope, so a VALUE
// import of it would follow the renderer into the browser bundle. `import type` is erased before the
// bundler ever sees it, which is what lets the state machine below be typed by the kernel's own
// vocabulary instead of a hand-copied union that could drift away from it.
import type { BashPlan, ConfinementReason, Enclosure, JailPostureWire } from "@novaclaw/core/agent-jail"

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Settings → General → "How this machine confines the agent" — *a capability probe + an honest
// posture surface*.
//
// WHY IT EXISTS. On 2026-07-30 the owner made unattended `bash` allowed by DEFAULT and deferred the
// real OS sandboxes (AppContainer, Seatbelt) to v0.3.0. The stated mitigations are an opt-in Safe
// mode, a project-scope instruction in every non-YOLO system prompt, and v0.3.0 owning confinement —
// and until this screen there was no way for a user to discover which of those applied to their own
// machine. A grep of `packages/app/src` for jail/sandbox/confinement found nothing at all. Ruling 2:
// *an unavailable subsystem names itself instead of rendering empty · a fault is never described
// falsely.*
//
// WHAT IT IS NOT. Not a warning screen. AGENTS.md: the UI never crashes to a dead-end, and the
// product is for a curious non-expert. Every state below says what is true, what still holds anyway,
// and what the user can do — a person should leave this row knowing something they did not know
// (principle 8), not feeling told off for running Windows.
//
// THE HONESTY RULE THIS FILE IS BUILT AROUND: it renders what the INSTANCE measured. The UI may be
// driving a headless instance on another machine (R1–R8), so nothing here may be answered from the
// browser's own platform, and where the instance has not answered, this screen says *that* rather
// than guessing. `confinementState` below has exactly one inference in it, and it is pinned by test.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

// The state machine and its types live in a component-free sibling so their ratchet can load under
// the unit tier. Imported for this file's own use AND re-exported, so existing importers of
// `./confinement` are unaffected — a bare `export … from` would re-export without binding locally.
import {
  confinementState,
  UNPROBED_ON_THIS_PLATFORM,
  type ConfinementState,
  type ShellStatusWithJail,
} from "./confinement-state"

export {
  BACKENDED_PLATFORMS,
  confinementState,
  UNPROBED_ON_THIS_PLATFORM,
  type ConfinementState,
  type ReportedPosture,
  type ShellStatusWithJail,
} from "./confinement-state"


/**
 * The posture an instance that did not report one necessarily has, on a platform where no backend
 * exists in this build. Not a fabrication: `detectBackend` returns `NO_BACKEND` for such a platform
 * without running anything, so `kind/fs/net/reason` are the only values it could have had — and the
 * probe fields stay ABSENT, because no probe happened and inventing an empty one would show the user
 * a test that was never run.
 *
 * ⚠️ `bash` is deliberately omitted: the per-turn outcomes are the KERNEL's answer, and computing
 * them here would be the restatement `bashPlan` exists to prevent. The outcomes row simply does not
 * render until an instance sends them.
 */

/**
 * The confinement rows, as part of the HEALTH REPORT rather than as a settings section.
 *
 * 🔴 Owner, 2026-08-19: *"Confinement shouldn't really be a user configurable, but part of the health
 * report, if it is available."* This used to be `SettingsConfinementSection` — a peer section in
 * Settings → General with its own "Confinement" heading, sitting among rows a person can change. It
 * never had a control in it (no switch, no button, no config write), so nothing configurable was
 * taken away when it moved: it was always a read-only reading of the user's own machine, which is
 * the definition of a health finding. It now renders as rows of `NovaHealthBoard` — hence no
 * `settings-v2-section` wrapper and no `<h3>` here; the report owns the heading. Each row's own
 * title still says what it is about ("Sandbox for the agent's shell", "What this machine already
 * runs inside"), so the grouping label was the only thing lost, and it was redundant.
 *
 * ⚠️ *"if it is available"* is load-bearing and is already implemented: `platform-unsupported`,
 * `backend-absent` and `backend-blocked` are three DIFFERENT user actions (wait for v0.3 / install
 * bwrap / fix AppArmor), so they must never collapse into one "unavailable". The report says which
 * one, on a platform that has no backend at all, rather than hiding the row.
 */
export const ConfinementRows: Component<{
  status?: ShellStatusWithJail
  /** The status fetch is still in flight — see `displayKind` for why this is not cosmetic. */
  loading?: boolean
}> = (props) => {
  const language = useLanguage()
  const state = () => confinementState(props.status)
  /**
   * ⚠️ "Still asking" is NOT "could not reach it". Without this arm, every open of Settings would
   * flash *"could not reach the instance to ask"* for the length of one HTTP round trip — which is
   * a fault described falsely (ruling 2) about this screen's own network call, and on a UI driving a
   * remote instance that flash is not brief. It is a display state only: `confinementState` stays a
   * pure function of what actually arrived.
   */
  const displayKind = () => (props.loading && !props.status ? "checking" : state().kind)
  const posture = () => {
    const value = state()
    return "jail" in value ? value.jail : undefined
  }
  // `process.platform` strings are for programs, not people — "win32" in a sentence aimed at a
  // curious non-expert is the obscurantism this product exists against. Written as three literal
  // calls rather than a computed key: the translator is key-typed and `dynamicKey` is a ledgered
  // escape hatch (i18n/key-typing.test.ts), so an unmapped platform falls back to its raw name
  // instead of buying a bypass.
  const platform = () => {
    const value = state()
    const raw = "platform" in value ? value.platform : ""
    if (raw === "win32") return language.t("settings.confinement.platform.win32")
    if (raw === "darwin") return language.t("settings.confinement.platform.darwin")
    if (raw === "linux") return language.t("settings.confinement.platform.linux")
    return raw
  }
  const backendLabel = () => {
    const kind = posture()?.kind
    // `kind` is `BackendKind` — a closed union derived from the kernel's `BACKEND_KINDS` array — so this key
    // cannot be built for a backend the bundle has no copy for — the compiler refuses, and
    // `confinement.test.ts` re-checks it at runtime for whoever adds one.
    return kind ? language.t(`settings.confinement.backend.${kind}`) : ""
  }

  /**
   * What encloses this instance, and its evidence.
   *
   * ⚠️ An instance that did not report the field is `unknown` — the same answer as one that measured
   * and could not tell. That collapse is deliberate here: both mean *we do not know*, and inventing a
   * fifth arm for "your instance is older than this screen" would be a distinction the reader cannot
   * act on. The evidence line says which it was.
   */
  const enclosureKind = (): Enclosure["kind"] => props.status?.enclosure?.kind ?? "unknown"
  const enclosureEvidence = () =>
    props.status?.enclosure?.evidence ?? language.t("settings.confinement.probe.unreported")

  // The probe, verbatim, so the claim above is checkable by hand rather than trusted.
  const probeDetail = () => {
    if (displayKind() === "checking") return language.t("settings.confinement.probe.checking")
    const value = posture()
    if (!value) return language.t("settings.confinement.probe.unreported")
    if (!value.probeCommand) return language.t("settings.confinement.probe.none", { platform: platform() })
    const outcome =
      value.probeExit !== undefined
        ? language.t("settings.confinement.probe.exit", { code: String(value.probeExit) })
        : value.probeError
          ? language.t("settings.confinement.probe.error", { detail: value.probeError })
          : language.t("settings.confinement.probe.noOutcome")
    return `${value.probeCommand} — ${outcome}`
  }

  return (
    <>
      {/*
          ONE row, not five. This section used to carry ~5 800 characters across five rows, two of
          which rendered `<span />` as their control — prose wearing a settings row's clothes.
          Nothing here is a setting, because the core does not implement OS confinement: the plan
          is a `set-up-isolation` RECIPE, and the Windows/macOS backends are v0.3. So this states
          the fact, names what protects the user meanwhile, and stops.

          It stays at Normal level deliberately: it is a safety-relevant fact about the user's own
          machine, and the anti-obscurantist principle says a lay person must be able to find it.
        */}
        <SettingsRowV2
          title={language.t("settings.confinement.title")}
          description={
            <>
              {language.t(`settings.confinement.reason.${displayKind()}`, {
                platform: platform(),
                backend: backendLabel(),
              })}
              {/* ⚠️ `meanwhile` is 455 characters and used to sit RIGHT HERE, inline, under every
                  visit — the owner quoted this exact row as the example of copy "cluttering our
                  UI". The state in force still leads (principle 12(d)); the four-sentence account
                  of what protects you meanwhile is one hover or tap away. */}
              <SettingsExplainV2 label={language.t("settings.confinement.title")}>
                {language.t("settings.confinement.meanwhile")}
              </SettingsExplainV2>
            </>
          }
        >
          <span data-slot="settings-confinement-verdict" class="text-[13px] text-v2-text-text-muted">
            {language.t(`settings.confinement.verdict.${displayKind()}`)}
          </span>
        </SettingsRowV2>

        {/*
          The OTHER half of "how boxed in is this?" — what already encloses NovaClaw, as opposed to
          what NovaClaw can put around a command. Two different questions with different answers, and
          merging them would force one of the two to be wrong (`agent-jail.ts` → THE ENCLOSURE).

          ⚠️ `unknown` is rendered as *"Not measured"*, never as "no". A boolean here would turn every
          host we cannot probe into "not in a container", which is a claim we have not earned — and on
          Windows, where there is no probe at all, it would be exactly the wrong one.
        */}
        <SettingsRowV2
          title={language.t("settings.confinement.enclosure.title")}
          description={
            <>
              {language.t("settings.confinement.enclosure.description")}{" "}
              {/* The EVIDENCE, verbatim, for the same reason the probe row exists below: a claim
                  about someone's machine that they cannot check is worth less than one they can. */}
              <span class="text-v2-text-text-faint">{enclosureEvidence()}</span>
            </>
          }
        >
          <span data-slot="settings-confinement-enclosure" class="text-[13px] text-v2-text-text-muted">
            {language.t(`settings.confinement.enclosure.${enclosureKind()}`)}
          </span>
        </SettingsRowV2>

        {/* Advanced+: the evidence behind the verdict above. Kept because the line above is a
            CLAIM about the user's machine, and a claim with no way to check it is worth less. */}
        <SettingsRowV2
          minLevel="advanced"
          title={language.t("settings.confinement.probe.title")}
          description={
            <>
              {language.t("settings.confinement.probe.description")}
              <SettingsExplainV2 label={language.t("settings.confinement.probe.title")}>
                {language.t("settings.confinement.probe.description.more")}
              </SettingsExplainV2>
            </>
          }
        >
          <code
            data-slot="settings-confinement-probe"
            class="min-w-0 select-all truncate rounded bg-v2-background-bg-deep px-1.5 py-1 text-[12px] text-v2-text-text-muted"
            title={probeDetail()}
          >
            {probeDetail()}
        </code>
      </SettingsRowV2>
    </>
  )
}
