import { For, Show, type Component } from "solid-js"
import { useLanguage } from "@/context/language"
import type { ShellStatus } from "@/utils/fs-api"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"
// ⚠️ TYPE-ONLY. `@novaclaw/core/agent-jail` imports `node:child_process` at module scope, so a VALUE
// import of it would follow the renderer into the browser bundle. `import type` is erased before the
// bundler ever sees it, which is what lets the state machine below be typed by the kernel's own
// vocabulary instead of a hand-copied union that could drift away from it.
import type { BashPlan, ConfinementReason, JailPostureWire } from "@novaclaw/core/agent-jail"

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Settings → General → "How this machine confines the agent" (todo/jail.md → *A capability probe +
// an honest posture surface*).
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

/**
 * The instance-reported shell status, plus the confinement posture the instance MAY attach to it.
 *
 * ⚠️ `jail` is optional because the field rides an existing response (`GET /shell/status`) and an
 * instance older than this screen does not send it. That is a first-class state here, not an error —
 * see `"unreported"` below.
 */
export type ShellStatusWithJail = ShellStatus & { readonly jail?: ReportedPosture }

/**
 * The posture as this screen may receive it.
 *
 * ⚠️ `bash` is optional HERE while it is required on the kernel's `JailPostureWire`, and the
 * widening is deliberate rather than sloppy: the one posture this screen may synthesise
 * (`UNPROBED_ON_THIS_PLATFORM`) has no per-turn outcomes, because those are the kernel's answers and
 * computing them in the renderer is exactly the restatement `bashPlan` exists to prevent. Modelling
 * that as "absent" costs one `Show`; modelling it with a cast would let a fabricated outcome table
 * reach a user. Everything else is the kernel's type, so a field added there arrives here typed.
 */
export type ReportedPosture = Omit<JailPostureWire, "bash"> & { readonly bash?: BashPlan }

/**
 * The platforms on which THIS build implements a sandbox backend.
 *
 * ⚠️ DERIVED, not decided here. `confinement.test.ts` drives the kernel's own `detectBackend` across
 * every platform string and fails if this list disagrees with it — so the day a Seatbelt or
 * AppContainer backend lands, the test goes red until this line and the copy catch up. Without that
 * pin this would be a normative claim about code in another package, which is the ruling-1 defect
 * class exactly.
 *
 * It is used for ONE inference, and only when the instance sent no posture: a host whose platform has
 * no backend at all cannot be confined, and saying so is not a guess. On a platform that DOES have a
 * backend, whether it works is unknowable from here (that is the whole AppArmor story), so we say we
 * do not know.
 */
export const BACKENDED_PLATFORMS: readonly string[] = ["linux"]

/**
 * What this screen can honestly say. Keyed by the kernel's own `ConfinementReason` wherever the
 * instance answered, plus the two states that are about the ANSWER rather than the host.
 */
export type ConfinementState =
  | { readonly kind: ConfinementReason; readonly jail: ReportedPosture; readonly platform: string }
  /** The instance is older than this screen: it has a backend-capable platform and did not say. */
  | { readonly kind: "unreported"; readonly platform: string }
  /** We could not reach the instance at all. Says "I do not know", never "you are unprotected". */
  | { readonly kind: "unknown" }

export function confinementState(status: ShellStatusWithJail | undefined): ConfinementState {
  if (!status) return { kind: "unknown" }
  const jail = status.jail
  if (jail) return { kind: jail.reason, jail, platform: status.platform }
  // No posture on the wire. Exactly one of the two remaining answers is honest.
  if (BACKENDED_PLATFORMS.includes(status.platform)) return { kind: "unreported", platform: status.platform }
  return { kind: "platform-unsupported", jail: UNPROBED_ON_THIS_PLATFORM, platform: status.platform }
}

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
const UNPROBED_ON_THIS_PLATFORM: ReportedPosture = {
  kind: "none",
  fs: false,
  net: false,
  reason: "platform-unsupported",
}

/** The four turn kinds, in the order a person meets them. Pinned exhaustive against `BashPlan`. */
export const TURN_KINDS = [
  "attended",
  "unattended",
  "unattendedSafeMode",
  "untrusted",
] as const satisfies readonly (keyof BashPlan)[]

/** Present when the instance reported the per-turn outcomes (an older instance does not). */
function planOf(state: ConfinementState): BashPlan | undefined {
  return "jail" in state ? state.jail.bash : undefined
}

export const SettingsConfinementSection: Component<{
  status?: ShellStatusWithJail
  /** The status fetch is still in flight — see `displayKind` for why this is not cosmetic. */
  loading?: boolean
}> = (props) => {
  const language = useLanguage()
  const state = () => confinementState(props.status)
  const plan = () => planOf(state())
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
    <div class="settings-v2-section" data-component="settings-confinement">
      <h3 class="settings-v2-section-title">{language.t("settings.confinement.section")}</h3>

      <SettingsListV2>
        {/* Normal level, deliberately. This is a safety-relevant fact about the user's OWN machine,
            and the anti-obscurantist principle says a lay person must be able to find it. The
            Trash-retention precedent settled the same tension the same way: the user-relevant row
            stays visible, the technical detail moves up a level. */}
        <SettingsRowV2
          title={language.t("settings.confinement.title")}
          description={
            <>
              {language.t("settings.confinement.description")}
              <br />
              {language.t(`settings.confinement.reason.${displayKind()}`, {
                platform: platform(),
                backend: backendLabel(),
              })}
            </>
          }
        >
          <span data-slot="settings-confinement-verdict" class="text-[13px] text-v2-text-text-muted">
            {language.t(`settings.confinement.verdict.${displayKind()}`)}
          </span>
        </SettingsRowV2>

        {/* The counterweight, and the reason this is not a scare screen: three things do not depend
            on the sandbox at all, and one of them is guidance rather than a wall — which is said out
            loud, because a promise the model merely follows is not the same promise as a box. */}
        <SettingsRowV2
          title={language.t("settings.confinement.guards.title")}
          description={language.t("settings.confinement.guards.description")}
        >
          <span />
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.confinement.safeMode.title")}
          description={
            <>
              {language.t("settings.confinement.safeMode.description")}
              <Show when={plan()}>
                {(value) => (
                  <>
                    {" "}
                    {value().unattended === value().unattendedSafeMode
                      ? language.t("settings.confinement.safeMode.noChange")
                      : language.t("settings.confinement.safeMode.changes")}
                  </>
                )}
              </Show>
            </>
          }
        >
          <span />
        </SettingsRowV2>

        {/* Advanced+: the evidence. Nothing above is asserted that this row cannot back up. */}
        <SettingsRowV2
          minLevel="advanced"
          title={language.t("settings.confinement.probe.title")}
          description={language.t("settings.confinement.probe.description")}
        >
          <code
            data-slot="settings-confinement-probe"
            class="min-w-0 select-all truncate rounded bg-v2-surface-surface-sunken px-1.5 py-1 text-[12px] text-v2-text-text-muted"
            title={probeDetail()}
          >
            {probeDetail()}
          </code>
        </SettingsRowV2>

        {/* Advanced+: what will ACTUALLY happen, per kind of turn — the kernel's own answers, not a
            summary of them. Absent when the instance did not send them, rather than computed here. */}
        <Show when={plan()}>
          {(value) => (
            <SettingsRowV2
              minLevel="advanced"
              title={language.t("settings.confinement.outcomes.title")}
              description={language.t("settings.confinement.outcomes.description")}
            >
              <div class="flex min-w-0 flex-col gap-0.5 text-[12px] text-v2-text-text-muted">
                <For each={TURN_KINDS}>
                  {(turn) => (
                    <div data-slot="settings-confinement-outcome">
                      {language.t(`settings.confinement.turn.${turn}`)}:{" "}
                      {language.t(`settings.confinement.decision.${value()[turn]}`)}
                    </div>
                  )}
                </For>
              </div>
            </SettingsRowV2>
          )}
        </Show>
      </SettingsListV2>
    </div>
  )
}
