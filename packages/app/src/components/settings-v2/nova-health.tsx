import { For, Show, createMemo, createResource, createSignal, type Component } from "solid-js"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { useConfirm } from "@/components/dialog-confirm"
import { memoryEraseVerified } from "@/utils/memory-api"
import { showToast } from "@/utils/toast"
import { useServer } from "@/context/server"
import { useServerSync } from "@/context/server-sync"
import { instanceDiagnosis, type DiagnosisSignal, type DiagnosisStatus } from "@/utils/resource-api"
import { shellStatus } from "@/utils/fs-api"
import { ConfinementRows, type ShellStatusWithJail } from "./confinement"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import { scopedDirectory } from "@/utils/routing-directory"
import { useNotification } from "@/context/notification"
import { usePlatform } from "@/context/platform"
import { fetchInstanceDiagnostics } from "@/utils/diagnostic-export"

/**
 * Nova Health — **the health report**: the one place that answers "is anything wrong with this
 * instance, and what do I do about it".
 *
 * 🔴 WHERE IT LIVES, AND THE RULE BEHIND IT (owner, 2026-08-19). This report used to lead Settings →
 * General, on the argument that a worried user must not have to read a language picker first. That
 * argument was right and the placement was still wrong, because General had by then accumulated
 * **two read-only status boards** — this one and Confinement — sitting among rows a person opens
 * that tab to CHANGE. The rule that resolves it, and that applies to the next board as well:
 *
 *   • **General is for what you SET.** Every row in it is a control: a preference, a switch, a
 *     picker, a button. If a person cannot change it, it does not belong there.
 *   • **A read-only reading of this instance is a FINDING, and findings go in the health report** —
 *     not beside it as a peer section, and not in General. That is why Confinement is now three rows
 *     of this report rather than a section of its own.
 *   • **The report lives in Health & recovery**, the tab whose whole subject is "something is wrong,
 *     help me fix it". `uix.md` §7 already assigned that section the pillar *understand + reset*;
 *     the report is the "understand" half and was simply never put there.
 *
 * ⚠️ **The discoverability argument had to survive the move, and it is carried by three things, not
 * one.** (1) The report LEADS its tab, above the reset rungs — the same "leads the tab" reasoning,
 * now in a tab that is about being worried. (2) The tab is named **Health & recovery**, so a worried
 * person scanning the rail reads their own question; "Recovery" alone hid it. (3) General keeps a
 * single row at the very top that points here — a control, not a board — so someone who lands on
 * General still meets the health affordance before the language picker, one click away.
 *
 * Two rules it exists to keep, both easy to undo by accident:
 *
 * 1. **`unknown` is never a tick.** Several readings can legitimately answer "cannot tell" — a
 *    pressure probe reports `unknown` rather
 *    than guessing. Rendering those as healthy is a false report on the one screen someone opens
 *    when they are already worried, so `unknown` gets its own neutral mark and its own words.
 * 2. **Opening this must not cost anything.** The endpoint deliberately gathers no reading that
 *    egresses, which is why refetching on open is safe here and would not be if a provider probe
 *    were folded in.
 *
 * ⚠️ There is deliberately **no green summary banner**. `overall` can only be as good as its worst
 * row, and a prominent "all good" is exactly the element that would keep saying "all good" if a row
 * ever silently stopped being gathered. The rows are the answer; the headline states the count.
 */

/** Neutral for `unknown` on purpose — an unread probe must not borrow the healthy colour. */
const MARK: Record<DiagnosisStatus, string> = {
  problem: "text-v2-state-fg-danger",
  warning: "text-v2-state-fg-warning",
  unknown: "text-v2-text-text-muted",
  ok: "text-v2-text-text-muted",
}

const GLYPH: Record<DiagnosisStatus, string> = {
  problem: "!",
  warning: "!",
  unknown: "?",
  ok: "OK",
}

export const NovaHealthBoard: Component = () => {
  const language = useLanguage()
  const server = useServer()
  const global = useGlobal()
  const sync = useServerSync()
  const notifications = useNotification()
  const platform = usePlatform()
  const connection = createMemo(() => server.current ?? global.servers.list()[0])
  // `probe` is a SIGNAL, not an argument to the initial load: the board must open without
  // contacting anyone, and only a deliberate click may spend egress.
  const [probe, setProbe] = createSignal(false)
  /**
   * ⚠️ `.catch(() => undefined)`, exactly as the confinement read below does, and for the reason
   * spelled out there: **an errored `createResource` THROWS the moment it is read**, so a fetcher
   * with no catch hands the outage to the root ErrorBoundary and the whole application is replaced.
   * On THIS board that was self-defeating — the "could not be reached" line twenty rows down could
   * never render, because the signal list read the accessor first and took the app down with it.
   * The tab a person opens *because* something is already wrong is the last one allowed to break in
   * their hands.
   *
   * ⚠️ And the catch must NOT be the whole fix. Folding the failure into the same `undefined` that
   * "not asked yet" produces would trade a crash for a lie — a silent, empty board on the one
   * screen where an unexplained blank is the worst possible answer. `unreachable()` below keeps the
   * two apart.
   *
   * ⚠️ The connection moved into the SOURCE (the shape the confinement read already uses). It was
   * dereferenced inside the fetcher, and a fetcher that throws SYNCHRONOUSLY is not caught by a
   * `.catch` on its result — it escapes through Solid's own computation, which is the same
   * dead-end by a shorter route. An instance-less board is now "not asked", which is what it is.
   */
  const [diagnosis, actions] = createResource(
    () => {
      const conn = connection()
      return conn ? { conn, probe: probe() } : undefined
    },
    (input) => instanceDiagnosis(input.conn.http, { probe: input.probe }).catch(() => undefined),
  )

  /**
   * A failed fetch is itself a finding, and saying so beats an empty panel that reads as "nothing
   * wrong". This is the screen where an unexplained blank is the worst possible answer.
   *
   * ⚠️ `state`, not `error` — the catch above means `error` is never set again, and a memo left
   * reading it would report every outage as healthy. `"ready"` is what Solid calls a resource whose
   * fetcher RESOLVED, so `ready` + `undefined` is precisely *we asked and got no answer*, while
   * "no instance yet" stays `"unresolved"` and "still asking" stays `"pending"` — neither of which
   * may be reported as a fault. `"errored"` stays as the honest reading of a resource that somehow
   * rejected anyway, and `||` short-circuits, so this memo never reads the accessor in the one
   * state where reading it would throw.
   */
  const unreachable = createMemo(
    () => diagnosis.state === "errored" || (diagnosis.state === "ready" && diagnosis() === undefined),
  )

  const confirm = useConfirm()
  const [erasing, setErasing] = createSignal(false)
  const [exporting, setExporting] = createSignal(false)
  const recentNotifications = createMemo(() => notifications.history.recent().slice(0, 20))

  const exportLogs = async () => {
    const conn = connection()
    if (!conn || !platform.exportDebugLogs) return
    setExporting(true)
    try {
      const diagnostics = await fetchInstanceDiagnostics(conn.http).catch(() => undefined)
      await platform.exportDebugLogs(diagnostics)
      showToast({ variant: "success", title: language.t("settings.health.logs.exported") })
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("settings.health.logs.failed"),
        description: String(error),
      })
    } finally {
      setExporting(false)
    }
  }
  /**
   * Erase every memory in every scope, Nova's included.
   *
   * ⚠️ Reports the COUNT and distinguishes zero. "Erased 0 memories" and "erased 1,412" are different
   * facts, and a store that was already empty must not be reported as though something happened —
   * that is the difference between a diagnostic and a reassurance.
   */
  const eraseMemory = async () => {
    const conn = connection()
    if (!conn) return
    if (
      !(await confirm({
        title: language.t("settings.health.eraseMemory.confirm.title"),
        description: language.t("settings.health.eraseMemory.confirm.description"),
        confirmLabel: language.t("settings.health.eraseMemory.confirm.action"),
        destructive: true,
      }))
    )
      return
    setErasing(true)
    try {
      const erased = await memoryEraseVerified(conn.http, { directory: confinementDir() })
      showToast({
        variant: "success",
        title:
          erased > 0
            ? language.t("settings.health.eraseMemory.done", { count: String(erased) })
            : language.t("settings.health.eraseMemory.empty"),
      })
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("settings.health.eraseMemory.failed"),
        description: String(error),
      })
    } finally {
      setErasing(false)
    }
  }

  /**
   * The confinement reading, fetched HERE rather than handed in as a prop.
   *
   * The report is now the home of every read-only reading, so it owns the fetches that feed it and
   * can be mounted wherever the tab layout puts it without a parent having to know what it needs.
   *
   * ⚠️ This is a SECOND `shell/status` call on a Settings open — General still makes its own for the
   * shell-bundle row, and the two do not share a cache. That is a real cost and it is named rather
   * than hidden: it is one local GET against the user's own instance (no egress, which is the rule
   * this board actually guards), and keeping a status board in the wrong tab to save it would be the
   * worse trade. If a third reader ever wants it, lift it to a shared query then.
   *
   * ⚠️ `.catch(() => undefined)` matches what General did with the same call: an unreachable
   * instance must reach `ConfinementRows` as "we do not know", which is a state it renders honestly,
   * and never as a throw that the root ErrorBoundary turns into "Something went wrong".
   */
  const confinementDir = createMemo(() => scopedDirectory(sync().data.path))
  const [shell] = createResource(
    () => {
      const conn = connection()
      const dir = confinementDir()
      return conn && dir ? { conn, dir } : undefined
    },
    ({ conn, dir }) =>
      shellStatus(conn.http, { directory: dir })
        .then((value) => value as ShellStatusWithJail)
        .catch(() => undefined),
  )

  return (
    <section class="flex flex-col gap-2" data-slot="nova-health">
      <div>
        <h3 class="settings-v2-section-title">{language.t("settings.health.title")}</h3>
        <p class="settings-v2-tab-description">
          <Show when={!diagnosis.loading} fallback={language.t("settings.health.checking")}>
            <Show when={!unreachable()} fallback={language.t("settings.health.unreachable")}>
              {diagnosis()?.headline}
            </Show>
          </Show>
        </p>
      </div>

      <SettingsListV2>
        <For each={diagnosis()?.signals ?? []}>
          {(signal: DiagnosisSignal) => (
            <SettingsRowV2
              title={signal.label}
              // The detail says what is true; the action says what to do. A row with neither is a
              // row that is genuinely fine, so it shows nothing rather than manufactured comfort.
              description={[signal.detail, signal.action].filter(Boolean).join(" ")}
            >
              <span class={`select-text text-[12px] ${MARK[signal.status]}`} data-status={signal.status}>
                {GLYPH[signal.status]}
              </span>
            </SettingsRowV2>
          )}
        </For>

        {/* Confinement, folded in (owner, 2026-08-19). It is a reading of the user's own machine
            with no control attached, which makes it a finding rather than a setting — so it renders
            as rows of this report, in this same list, instead of as a section of its own in General.
            It goes AFTER the server's signals deliberately: those answer "is this instance working",
            this answers "how boxed in is what it runs", and the second is only interesting once the
            first is. See `confinement.tsx` for what each arm may and may not claim. */}
        <ConfinementRows status={shell.latest} loading={shell.loading} />
      </SettingsListV2>

      <div class="flex gap-3">
        <button type="button" class="settings-v2-tab-description underline" onClick={() => void actions.refetch()}>
          {language.t("settings.health.recheck")}
        </button>
        {/* Separate from "Check again" ON PURPOSE, and worded so the cost is visible before the
            click: this is the only control on the screen that leaves the machine. */}
        <button
          type="button"
          class="settings-v2-tab-description underline"
          onClick={() => {
            setProbe(true)
            void actions.refetch()
          }}
        >
          {language.t("settings.health.testProvider")}
        </button>
        {/* 🔴 ERASE MEMORY (owner, 2026-08-22) — "erases all RAGs from all agents, including Nova …
            that will simplify running tabula rasa tests, without resetting entire Novaclaw install."

            It lives on HEALTH rather than in the Memory app because it is not a memory-management
            action: nobody erases every colleague's recall to tidy up. It is the reset you reach for
            when you want to know how the product behaves with nothing learned, which is a
            diagnostic — the same reason "Test the connection" sits here rather than under Models.

            ⚠️ Rendered LAST and styled apart from the two checks above: they are read-only and this
            one destroys the user's own data. The confirm names the blast radius and what SURVIVES,
            because "erase all memory" reads as "this chat's" to most people. */}
        <button
          type="button"
          data-action="erase-memory"
          disabled={erasing()}
          class="settings-v2-tab-description ml-auto text-v2-state-fg-danger underline disabled:opacity-60"
          onClick={() => void eraseMemory()}
        >
          {erasing() ? language.t("settings.health.eraseMemory.erasing") : language.t("settings.health.eraseMemory")}
        </button>
      </div>

      <div class="mt-4 flex items-center justify-between gap-3">
        <div>
          <h3 class="settings-v2-section-title">{language.t("settings.health.notifications.title")}</h3>
          <p class="settings-v2-tab-description">{language.t("settings.health.notifications.description")}</p>
        </div>
        <Show when={platform.exportDebugLogs}>
          <button
            type="button"
            class="settings-v2-tab-description shrink-0 underline disabled:opacity-60"
            disabled={exporting()}
            onClick={() => void exportLogs()}
          >
            {exporting() ? language.t("settings.health.logs.exporting") : language.t("settings.health.logs.export")}
          </button>
        </Show>
      </div>
      <SettingsListV2>
        <For each={recentNotifications()}>
          {(notification) => (
            <SettingsRowV2
              title={
                notification.type === "toast"
                  ? notification.title || notification.description || language.t("settings.health.notifications.notice")
                  : notification.type === "error"
                    ? language.t("settings.health.notifications.error", { session: notification.session ?? "NovaClaw" })
                    : language.t("settings.health.notifications.complete", {
                        session: notification.session ?? "NovaClaw",
                      })
              }
              description={
                notification.type === "toast" && notification.title
                  ? notification.description
                  : new Date(notification.time).toLocaleString()
              }
            >
              <span class="select-text text-[11px] text-v2-text-text-muted">
                {new Date(notification.time).toLocaleString()}
              </span>
            </SettingsRowV2>
          )}
        </For>
        <Show when={recentNotifications().length === 0}>
          <SettingsRowV2
            title={language.t("settings.health.notifications.empty")}
            description={language.t("settings.health.notifications.emptyDescription")}
          >
            <span />
          </SettingsRowV2>
        </Show>
      </SettingsListV2>
    </section>
  )
}
