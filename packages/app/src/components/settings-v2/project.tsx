import { For, Show, Switch, Match, createMemo, createResource, type Component, type JSX } from "solid-js"
import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { useServerSync } from "@/context/server-sync"
import { instanceFetch } from "@/utils/instance-fetch"
import type { ProjectPermissionRule, ProjectState } from "@/utils/project-api"
import { projectState } from "@/utils/project-api"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import { SettingsExplainV2 } from "./explain"
import { projectSectionCopy } from "./project-copy"
import { projectExclusionCopy } from "./project-exclusion-copy"
import type { ShellStatusWithJail } from "./confinement-state"
import { ProjectExcludeSection, ProjectGitignoreImport, ProjectPermissionsSection } from "./project-permissions-section"
import { scopedDirectory } from "@/utils/routing-directory"

/**
 * Which `novaclaw.json` governs this folder.
 *
 * The rule: *"never make a person infer project state from a hidden dotfile."* A project
 * file can NARROW a session's permissions, and until this screen existed the only way to discover
 * that was to be refused and go looking. It sits beside Confinement for the reason Confinement sits
 * where it does — it answers the question the safety rows above it raise: what else is deciding what
 * the agent may do here.
 *
 * ⚠️ The fact rows report the rule COUNT and where the file is. The RULES themselves — and the two
 * other places rules come from — live in `ProjectPermissionsSection` below them, which is the
 * surface the programme asked for. Until 2026-08-18 the comment here said the permission
 * surface rendered them; no such surface existed, so the count was the only thing anyone could see.
 *
 * 🔴 **WHICH FOLDER. The target is the INSTANCE's directory, and that is correct — do not "fix" it.**
 * Settings is an instance-wide dialog; pointing this section at the active chat's folder would make
 * one dialog describe a different subject depending on which tab was open behind it. What was
 * genuinely broken until 2026-08-19 is that no sentence here ever NAMED that folder: the rows said
 * *"This folder is not a Project"* and *"Add a novaclaw.json **here**"* with no antecedent on screen.
 * On a desktop launch the instance's folder is the user's HOME, so the section appeared to offer to
 * make `C:\Users\<name>` a Project, and a reader with a project chat open reasonably concluded it was
 * pointed at the wrong place — twice, by two different readers. Every sentence now interpolates the
 * path (`project-copy.ts`, pinned by `project-copy.test.ts`). **If you add a state here, name the
 * folder in it.**
 */

/** The right-hand value slot. Muted, because every row here is a FACT rather than a control. */
const Value: Component<{ children: JSX.Element }> = (props) => (
  <span class="text-[13px] text-v2-text-text-muted">{props.children}</span>
)

export const SettingsProjectSection: Component<{
  /** The instance's own posture, already fetched by General for its shell control. */
  readonly shellStatus?: ShellStatusWithJail
  /** Opens the health report at the confinement rows; absent outside the Settings dialog. */
  readonly onOpenConfinement?: () => void
}> = (props) => {
  const language = useLanguage()
  const server = useServer()
  const global = useGlobal()
  const sync = useServerSync()
  const connection = createMemo(() => server.current ?? global.servers.list()[0])
  const directory = createMemo(() => scopedDirectory(sync().data.path))
  // Read separately, because `directory` above has already FOLDED the home into itself as a
  // fallback — so by the time the copy sees it, "the instance is working in the home" is
  // indistinguishable from any other folder. The home is what decides which of the two "not a
  // Project" sentences a user reads (principle 11: the home's top level is somewhere we are careful
  // about writing), so the copy needs it as a separate fact rather than as a fallback.
  const home = createMemo(() => sync().data.path.home || "")
  const source = createMemo(() => {
    const http = connection()?.http
    const dir = directory()
    return http && dir ? { http, dir } : undefined
  })
  /**
   * ⚠️ `.catch(() => undefined)` — the guard `savedRules` below already carries, now on the read the
   * whole section hangs from. **An errored `createResource` THROWS when it is read**, and
   * `<Show when={state()}>` is a read, so an instance that could not answer `GET /api/project`
   * replaced the entire application with "Something went wrong" — from the DEFAULT Settings tab.
   * The comment below records this consequence for the secondary read; the primary one was missed.
   *
   * ⚠️ The catch alone would be the other half of the same defect. `undefined` is also what "still
   * loading" looks like, so swallowing a failure into it makes the section quietly vanish and claim
   * by omission that there is nothing to say about this folder. `unavailable()` keeps the two apart
   * and the render names the failure.
   */
  const [state, { refetch }] = createResource(source, (value) =>
    projectState(value.http, value.dir).catch(() => undefined),
  )
  /**
   * The fetch RAN and produced no answer — as distinct from "not asked yet" (`"unresolved"`: no
   * connection or no directory) and "still asking" (`"pending"`). `||` short-circuits, so the
   * accessor is never read in the one state where reading it would throw.
   */
  const unavailable = createMemo(
    () => state.state === "errored" || (state.state === "ready" && state() === undefined),
  )
  const http = createMemo(() => connection()?.http)

  /**
   * The user's own saved answers — the SECOND of the three origins.
   *
   * ⚠️ Degrades to `undefined` rather than throwing. A throw inside a `createResource` read reaches
   * the ROOT ErrorBoundary and replaces the whole application (review 1.15), and a permission list
   * that failed to load must never cost someone their chats. `undefined` renders nothing, which is
   * honest: the block has not been told, so it claims nothing.
   *
   * 🔴 **`instanceFetch`, NOT `useSDK()` — and that guard above is exactly why this had to change.**
   * `useSDK` is the DIRECTORY-scoped SDK, and `SDKProvider` is mounted only inside the session and
   * draft routes (`app.tsx`). A dialog runs under the owner of whoever called `useDialog()`
   * (`ui/context/dialog.tsx` → `runWithOwner(base, …)`), and both real ways into Settings — the home
   * screen's tile (`apps/builtins.tsx`) and the shell's mod+comma command (`pages/layout-new.tsx`) —
   * sit ABOVE that provider. So `useSDK()` threw at component setup, before any resource existed for
   * the try/catch to protect, and the root ErrorBoundary replaced the whole application with
   * "Something went wrong" the moment anyone opened Settings. Measured in a production
   * `electron-vite build` on 2026-08-19, from both entry points. The composer's own
   * `useSettingsDialog` call IS inside the provider, which is why the surface looked fine to
   * whoever drove it from a chat.
   */
  // ⚠️ The MEMO is the source, not a fresh `{http, dir}` literal. A source function that mints a new
  // object each read changes identity on every reactive pass, which is a refetch loop nobody asked
  // for — the trap `session-composer-controls.ts` records against the draft's own project probe.
  const [savedRules] = createResource(source, async (value): Promise<readonly ProjectPermissionRule[] | undefined> => {
    try {
      const answer = await instanceFetch<{
        data?: readonly { action: string; resource: string; effect?: string }[]
      }>(value.http, { route: "api/permission/saved", directory: value.dir })
      const rows = answer.data
      if (!rows) return undefined
      // ⚠️ A legacy row carries no `effect` and means "allow" — the schema says so
      // (`PermissionSaved.Info`), and defaulting it to anything else would misreport an old
      // grant as a refusal on the one screen a user consults after being refused.
      return rows.map((row) => ({
        action: row.action,
        resource: row.resource,
        effect: (row.effect ?? "allow") as ProjectPermissionRule["effect"],
      }))
    } catch {
      return undefined
    }
  })

  const invalid = createMemo(() => {
    const value = state()
    return value?.kind === "invalid" ? value : undefined
  })
  const project = createMemo(() => {
    const value = state()
    return value?.kind === "project" ? value : undefined
  })
  // Every sentence that names the folder lives in one pure module, so the naming is testable rather
  // than scattered across three JSX branches where a fourth could quietly forget it.
  const copy = createMemo(() =>
    projectSectionCopy({ state: state(), directory: directory(), home: home(), t: language.t }),
  )
  const exclusionCopy = createMemo(() =>
    projectExclusionCopy({
      count: project()?.exclude.length ?? 0,
      shellStatus: props.shellStatus,
      t: language.t,
    }),
  )

  return (
    <Show
      // ⚠️ `unavailable()` FIRST, and the accessor only in the other arm. A resource that rejected
      // throws from its own accessor, so a `when` that reads it before asking whether the read is
      // safe is the crash this guard exists to prevent, written one line higher up.
      when={unavailable() ? undefined : state()}
      fallback={
        // An unavailable subsystem NAMES itself instead of rendering empty. Nothing below could be
        // read, so the section says so under its own heading rather than disappearing — and rather
        // than leaving the permission and exclusion editors up, which would offer to write rules
        // against a state nobody actually has.
        //
        // ⚠️ The health board's sentence, deliberately, not a second one of our own: it is the same
        // fault with the same remedy, and this file already shares `invalid*` with
        // `project-summary.ts` for exactly that reason — surfaces that report one fault must not
        // come to disagree about what it was.
        <Show when={unavailable()}>
          <div class="settings-v2-section" data-component="settings-project">
            <h3 class="settings-v2-section-title">{language.t("settings.project.section")}</h3>
            <p class="settings-v2-tab-description" data-slot="project-unavailable">
              {language.t("settings.health.unreachable")}
            </p>
          </div>
        </Show>
      }
    >
      {(resolved) => (
        <div class="settings-v2-section" data-component="settings-project">
          <h3 class="settings-v2-section-title">{language.t("settings.project.section")}</h3>
          {/* Principle 12(d) — say what is in force right now, BEFORE any control. This line is the
              whole fix for the defect the header describes: it names the folder these rows describe,
              and says out loud that it is the instance's folder rather than the open chat's, which
              is the inference two readers made wrongly because nothing here contradicted it. */}
          <p class="settings-v2-tab-description" data-slot="project-subject">
            {copy()?.subject}
          </p>

          <SettingsListV2>
            <Switch>
              <Match when={resolved().kind === "none"}>
                {/* Not an error and not a nag: a folder without one is perfectly usable, and saying
                    so plainly is the difference between an explanation and a prompt to fix nothing.
                    The home folder gets a different second sentence — see `project-copy.ts`. */}
                <SettingsRowV2 title={copy()?.title ?? ""} description={copy()?.description ?? ""}>
                  <span />
                </SettingsRowV2>
              </Match>

              <Match when={invalid()}>
                {(broken) => (
                  // ⚠️ The two reasons get DIFFERENT sentences on purpose. "Update NovaClaw" and
                  // "fix your file" are opposite actions, and one message covering both would send
                  // half its readers the wrong way. Both come from `project-copy.ts` now.
                  <SettingsRowV2 title={copy()?.title ?? ""} description={copy()?.description ?? ""}>
                    <Value>{broken().file}</Value>
                  </SettingsRowV2>
                )}
              </Match>

              <Match when={project()}>
                {(info) => (
                  <>
                    {/* Always rendered, where the old name row appeared only when the file declared
                        a name — so an unnamed Project used to open with "Declared in <path>" and
                        never said which folder was the subject. It also distinguishes a file in THIS
                        folder from one in an ancestor governing it, which "Declared in" alone cannot. */}
                    <SettingsRowV2 title={copy()?.title ?? ""} description={copy()?.description ?? ""}>
                      <span />
                    </SettingsRowV2>
                    <SettingsRowV2
                      title={language.t("settings.project.fileLabel")}
                      description={language.t("settings.project.fileDetail")}
                    >
                      <Value>{info().file}</Value>
                    </SettingsRowV2>
                    <SettingsRowV2
                      title={language.t("settings.project.rulesLabel")}
                      description={
                        info().permissionRules === 0
                          ? language.t("settings.project.rulesNone")
                          : language.t("settings.project.rulesValue")
                      }
                    >
                      <Value>{String(info().permissionRules)}</Value>
                    </SettingsRowV2>
                    {/* Shown even when the list is EMPTY, like the permission-rules row above it.
                        The visible sentence distinguishes the dedicated path tools' enforcement
                        from raw shell's best-effort screen, and derives the sandbox clause from the
                        instance's own posture rather than the renderer's machine. */}
                    <SettingsRowV2
                      title={language.t("settings.project.excludeLabel")}
                      description={
                        <>
                          {exclusionCopy()}
                          <SettingsExplainV2 label={language.t("settings.project.excludeLabel")}>
                            {language.t("settings.project.excludeDetail.more")}
                          </SettingsExplainV2>
                        </>
                      }
                    >
                      <div class="flex flex-col items-end gap-2">
                        <Value>
                          <For each={info().exclude}>{(pattern) => <div>{pattern}</div>}</For>
                        </Value>
                        <Show when={props.onOpenConfinement}>
                          <ButtonV2 size="normal" variant="neutral" onClick={() => props.onOpenConfinement?.()}>
                            {language.t("settings.project.excludeSandboxAction")}
                          </ButtonV2>
                        </Show>
                      </div>
                    </SettingsRowV2>
                  </>
                )}
              </Match>
            </Switch>
          </SettingsListV2>

          {/* ⚠️ OUTSIDE the Switch, so it renders for a folder with no project file too. That is the
              whole point of principle 12(a): a setting is an override, not a doorway, and a person
              who wants to give this folder its own rules must not first have to know that a file
              called novaclaw.json is the way to ask. Saving here creates it. */}
          <ProjectPermissionsSection
            state={state}
            connection={http}
            directory={directory}
            saved={savedRules}
            refresh={refetch}
          />
          <ProjectExcludeSection
            state={state}
            connection={http}
            directory={directory}
            saved={savedRules}
            refresh={refetch}
          />
          <ProjectGitignoreImport
            state={state}
            connection={http}
            directory={directory}
            saved={savedRules}
            refresh={refetch}
          />
        </div>
      )}
    </Show>
  )
}

export type { ProjectState }
