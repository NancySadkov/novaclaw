import { A, useLocation, useSearchParams } from "@solidjs/router"
import { RecipesPage } from "./recipes"
import { createEffect, createMemo, createSignal, For, Index, onCleanup, Show, type JSX } from "solid-js"
import type { WorkProject } from "@novaclaw/schema/work-project"
import { Icon } from "@novaclaw/ui/v2/icon"
import { SelectV2 } from "@novaclaw/ui/v2/select-v2"
import { AppPage } from "@/components/app-page"
import { useDirectoryPicker } from "@/components/directory-picker"
import { useConfirm, type ConfirmOptions } from "@/components/dialog-confirm"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { createSettledResource } from "@/utils/settled-resource"
import { AgentPortrait } from "@/components/agent-portrait"
import { createRecipeLauncher } from "@/components/recipe-launcher"
import { useServer } from "@/context/server"
import { useGlobal } from "@/context/global"
import { useExpertise } from "@/context/expertise"
import { agentHref } from "@/utils/session-route"
import { listDeployedRecipes, type RecipeDeployment } from "@/utils/recipe-api"
import { projectsApi, type ProjectsApi } from "@/utils/projects-api"

type Translate = ReturnType<typeof useLanguage>["t"]
type Draft = {
  id?: string
  revision?: number
  name: string
  objective: string
  directory: string
  phases: WorkProject.Phase[]
}

export function ProjectsPage() {
  const location = useLocation()
  const [params] = useSearchParams()
  const sdk = useServerSDK()
  const server = useServer()
  const global = useGlobal()
  const expertise = useExpertise()
  const launcher = createRecipeLauncher(() => server.current)
  const roster = createMemo(() => (server.current ? global.ensureServerCtx(server.current).agents.list() : []))
  const [deployments, { refetch: refreshDeployments }] = createSettledResource(
    () => sdk()?.server.http,
    listDeployedRecipes,
  )
  createEffect(() => {
    if (!sdk()) return
    const timer = setInterval(() => {
      if (!deployments.loading) void refreshDeployments()
    }, 5000)
    onCleanup(() => clearInterval(timer))
  })
  const language = useLanguage()
  const confirm = useConfirm()
  const pickDirectory = useDirectoryPicker()
  const api = createMemo(() => {
    const base = sdk()?.server.http
    if (!base) return undefined
    const controller = new AbortController()
    onCleanup(() => controller.abort())
    return projectsApi(base, controller.signal)
  })
  return (
    <div class="projects-hub">
      <nav class="projects-hub-nav" aria-label="Projects and recipes">
        <A href="/projects" classList={{ active: location.pathname !== "/recipes" }}>
          Projects
        </A>
        <A href="/recipes" classList={{ active: location.pathname === "/recipes" }}>
          Recipes
        </A>
      </nav>
      <Show when={location.pathname !== "/recipes"} fallback={<RecipesPage />}>
        <ProjectsPanel
          selectedID={typeof params.project === "string" ? params.project : undefined}
          api={api()}
          t={language.t}
          confirm={confirm}
          advanced={expertise.atLeast("advanced")}
          deployments={deployments()}
          launchUnavailable={deployments.failed}
          opening={launcher.opening()}
          onLaunch={(project) => launcher.open({ projectID: project.id, name: project.name })}
          officerLink={(id) => agentHref(server.key, id)}
          portrait={(officer) => (
            <AgentPortrait
              id={officer.id}
              name={officer.name}
              avatar={roster().find((row) => row.id === officer.id)?.avatar}
              connection={server.current}
              class="project-officer-portrait"
            />
          )}
          pickDirectory={(onSelect) => {
            const server = sdk()?.server
            if (!server) return
            pickDirectory({
              server,
              title: language.t("projects.directory"),
              multiple: false,
              onSelect: (value) => {
                if (typeof value === "string") onSelect(value)
              },
            })
          }}
        />
      </Show>
      <launcher.View />
    </div>
  )
}

export function ProjectsPanel(props: {
  selectedID?: string
  api: ProjectsApi | undefined
  t: Translate
  confirm: (options: ConfirmOptions) => Promise<boolean>
  pickDirectory?: (onSelect: (directory: string) => void) => void
  advanced?: boolean
  deployments?: readonly RecipeDeployment[]
  launchUnavailable?: boolean
  opening?: string
  onLaunch?: (project: WorkProject.Info) => Promise<void>
  officerLink?: (id: string) => string
  portrait?: (officer: WorkProject.Officer) => JSX.Element
}) {
  const t = props.t
  const [data, { refetch, mutate }] = createSettledResource(
    () => props.api,
    (api) => api.list(),
  )
  const [selected, setSelected] = createSignal<string | undefined>(props.selectedID)
  const [query, setQuery] = createSignal("")
  const [filter, setFilter] = createSignal<"all" | "active" | "complete" | "paused">("all")
  const [draft, setDraft] = createSignal<Draft>()
  const [dirty, setDirty] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const filterOptions = () => [
    { id: "all" as const, label: t("projects.all") },
    { id: "active" as const, label: "In progress" },
    { id: "complete" as const, label: "Completed" },
    { id: "paused" as const, label: t("projects.paused") },
  ]
  const projects = () => data()?.projects ?? []
  const officers = () => data()?.officers ?? []
  const current = createMemo(() => projects().find((project) => project.id === selected()))
  const complete = (project: WorkProject.Info) =>
    project.totalPhases > 0 && project.completedPhases === project.totalPhases
  const deployment = (project: WorkProject.Info) => props.deployments?.find((entry) => entry.projectID === project.id)
  const state = (project: WorkProject.Info) =>
    deployment(project)?.state === "ready"
      ? "ready"
      : project.paused
        ? "paused"
        : complete(project)
          ? "complete"
          : project.workingOfficers
            ? "working"
            : "idle"
  const stateLabel = (project: WorkProject.Info) =>
    ({
      paused: "Paused",
      ready: "Ready to open",
      complete: "Plan complete",
      working: "Working",
      idle: "Awaiting work",
    })[state(project)]
  const manager = (project: WorkProject.Info) => officers().find((officer) => officer.id === project.recipe?.manager)
  const visible = createMemo(() =>
    projects()
      .filter(
        (project) =>
          (filter() === "all" ||
            (filter() === "paused"
              ? project.paused
              : filter() === "complete"
                ? complete(project)
                : !project.paused && !complete(project))) &&
          `${project.name} ${project.objective}`.toLocaleLowerCase().includes(query().trim().toLocaleLowerCase()),
      )
      .map((project) => project.id),
  )
  const totals = createMemo(() => ({
    active: projects().filter((project) => !project.paused && !complete(project)).length,
    working: projects().reduce((sum, project) => sum + project.workingOfficers, 0),
  }))

  createEffect(() => {
    const api = props.api
    setSelected(props.selectedID)
    setDraft(undefined)
    setDirty(false)
    setError(undefined)
    if (!api) return
    const timer = setInterval(() => {
      if (!data.loading && !busy()) void refetch()
    }, 5000)
    onCleanup(() => clearInterval(timer))
  })
  const leaveDraft = async () =>
    !dirty() ||
    props.confirm({
      title: t("projects.discardTitle"),
      description: t("projects.discardBody"),
      confirmLabel: t("projects.discard"),
    })
  const open = async (id?: string) => {
    if (busy() || !(await leaveDraft())) return
    setDraft(undefined)
    setDirty(false)
    setError(undefined)
    setSelected(id)
  }
  const edit = async (project?: WorkProject.Info) => {
    if (busy() || !(await leaveDraft())) return
    setSelected(project?.id)
    setError(undefined)
    setDirty(false)
    setDraft(
      project
        ? {
            id: project.id,
            revision: project.revision,
            name: project.name,
            objective: project.objective,
            directory: project.directory ?? "",
            phases: project.phases.map((phase) => ({ ...phase })),
          }
        : { name: "", objective: "", directory: "", phases: [] },
    )
  }
  const change = (patch: Partial<Draft>) => {
    setDraft((value) => value && { ...value, ...patch })
    setDirty(true)
  }
  const phaseChange = (index: number, patch: Partial<WorkProject.Phase>) =>
    change({ phases: draft()!.phases.map((phase, i) => (i === index ? { ...phase, ...patch } : phase)) })
  const movePhase = (index: number, offset: number) => {
    const phases = [...draft()!.phases]
    const target = index + offset
    if (target < 0 || target >= phases.length) return
    ;[phases[index], phases[target]] = [phases[target]!, phases[index]!]
    change({ phases })
  }
  const execute = async (command: WorkProject.Command) => {
    const api = props.api
    if (!api || busy()) return undefined
    setBusy(true)
    setError(undefined)
    try {
      const result = await api.execute(command)
      if (props.api !== api) return undefined
      mutate(result)
      return result
    } catch (cause) {
      if (props.api === api) setError(cause instanceof Error ? cause.message : t("projects.saveFailed"))
      return undefined
    } finally {
      setBusy(false)
    }
  }
  const save = async () => {
    const value = draft()
    if (!value) return
    const known = new Set(projects().map((project) => project.id))
    const result = await execute(
      value.id
        ? {
            op: "edit",
            id: value.id,
            revision: value.revision!,
            name: value.name,
            objective: value.objective,
            directory: value.directory.trim() || null,
            phases: value.phases,
          }
        : {
            op: "create",
            name: value.name,
            objective: value.objective,
            directory: value.directory.trim() || null,
            phases: value.phases,
          },
    )
    if (!result) return
    setSelected(value.id ?? result.projects.find((project) => !known.has(project.id))?.id)
    setDraft(undefined)
    setDirty(false)
  }
  const remove = async (project: WorkProject.Info) => {
    if (
      !(await props.confirm({
        title: project.recipe ? `Undeploy “${project.name}”?` : t("projects.deleteTitle", { name: project.name }),
        description: project.recipe
          ? `Retire this project's team and remove its folder and generated files: ${project.directory}`
          : t("projects.deleteBody"),
        confirmLabel: project.recipe ? "Undeploy" : t("projects.delete"),
        destructive: true,
      }))
    )
      return
    if (!project.recipe) {
      if (await execute({ op: "delete", id: project.id, revision: project.revision })) setSelected(undefined)
      return
    }
    const api = props.api
    if (!api || busy()) return
    setBusy(true)
    setError(undefined)
    try {
      await api.undeploy(project.id)
      if (props.api !== api) return
      setSelected(undefined)
      await refetch()
      window.dispatchEvent(new Event("novaclaw:recipe-deployed"))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("projects.saveFailed"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <AppPage class="projects-page">
      <header class="projects-header">
        <div class="projects-heading">
          <div>
            <h1>{t("home.app.projects.name")}</h1>
            <p>Your work, with a team behind it.</p>
          </div>
        </div>
        <div class="projects-overview" aria-label={t("projects.overview")}>
          <span>
            <b>{totals().active}</b>
            In progress
          </span>
          <span>
            <b>{totals().working}</b>
            {t("projects.working")}
          </span>
        </div>
        <button class="project-button primary" disabled={busy() || !props.api} onClick={() => void edit()}>
          <Icon name="plus" size="small" />
          {t("projects.new")}
        </button>
      </header>
      <Show when={error()}>
        <div class="projects-notice" role="alert">
          {error()}
        </div>
      </Show>
      <Show when={data.failed}>
        <div class="projects-notice" role="status">
          {t("projects.loadFailed")}{" "}
          <button class="project-button" onClick={() => void refetch()}>
            {t("projects.retry")}
          </button>
        </div>
      </Show>
      <Show when={data.idle || (data.loading && !data())}>
        <p class="projects-empty" role="status">
          {data.idle ? t("projects.connecting") : t("projects.loading")}
        </p>
      </Show>
      <div class="projects-workspace" data-detail={!!draft() || !!current()}>
        <section class="projects-library" aria-label={t("projects.list")}>
          <div class="projects-toolbar">
            <input
              class="project-field project-search"
              type="search"
              aria-label={t("projects.search")}
              placeholder={t("projects.search")}
              value={query()}
              onInput={(event) => setQuery(event.currentTarget.value)}
            />
            <SelectV2
              aria-label={t("projects.filter")}
              options={filterOptions()}
              current={filterOptions().find((option) => option.id === filter())}
              value={(option) => option.id}
              label={(option) => option.label}
              onSelect={(option) => {
                if (option) setFilter(option.id)
              }}
            />
          </div>
          <Show when={data() && !visible().length}>
            <div class="projects-empty">
              <h2>{projects().length ? t("projects.noMatches") : t("projects.empty")}</h2>
              <p>{projects().length ? t("projects.adjustSearch") : t("projects.emptyHint")}</p>
            </div>
          </Show>
          <div class="projects-grid">
            <For each={visible()}>
              {(id) => {
                const project = () => projects().find((row) => row.id === id)!
                const percent = () =>
                  project().totalPhases ? Math.round((100 * project().completedPhases) / project().totalPhases) : 0
                return (
                  <button
                    class="project-card"
                    classList={{ selected: selected() === id }}
                    data-paused={project().paused}
                    onClick={() => void open(id)}
                    aria-pressed={selected() === id}
                  >
                    <div class="project-card-top">
                      <h2>{project().name}</h2>
                      <span class="project-state" data-state={state(project())}>
                        {stateLabel(project())}
                      </span>
                    </div>
                    <p class="project-objective-preview">{project().objective}</p>
                    <Show when={manager(project())}>
                      {(lead) => (
                        <div class="project-card-manager">
                          {props.portrait?.(lead())}
                          <span>
                            {lead().name}
                            <small>Manager</small>
                          </span>
                        </div>
                      )}
                    </Show>
                    <div class="project-progress-label">
                      <span>
                        {t("projects.phaseCount", {
                          complete: project().completedPhases,
                          total: project().totalPhases,
                        })}
                      </span>
                      <b>{percent()}%</b>
                    </div>
                    <progress
                      value={project().completedPhases}
                      max={project().totalPhases || 1}
                      aria-label={t("projects.progress")}
                    />
                    <div class="project-card-stats">
                      <span>
                        <i class="project-live-dot" data-working={project().workingOfficers > 0} />
                        <b>{project().workingOfficers}</b>
                        {t("projects.working")}
                      </span>
                      <span>
                        <b>{project().totalOfficers}</b>
                        {t("projects.officers")}
                      </span>
                    </div>
                  </button>
                )
              }}
            </For>
          </div>
        </section>
        <Show when={draft()}>
          {(value) => (
            <section class="project-detail" aria-label={t("projects.editor")}>
              <form
                onSubmit={(event) => {
                  event.preventDefault()
                  void save()
                }}
              >
                <div class="project-detail-heading">
                  <h2>{value().id ? t("projects.edit") : t("projects.new")}</h2>
                  <button class="project-button" type="button" disabled={busy()} onClick={() => void open(value().id)}>
                    {t("projects.cancel")}
                  </button>
                </div>
                <label class="project-label">
                  {t("projects.name")}
                  <input
                    class="project-field"
                    required
                    maxLength={160}
                    value={value().name}
                    onInput={(event) => change({ name: event.currentTarget.value })}
                  />
                </label>
                <label class="project-label">
                  {t("projects.objective")}
                  <textarea
                    class="project-field"
                    required
                    maxLength={16000}
                    rows={5}
                    value={value().objective}
                    onInput={(event) => change({ objective: event.currentTarget.value })}
                  />
                </label>
                <label class="project-label">
                  {t("projects.directory")}
                  <input
                    class="project-field"
                    maxLength={4096}
                    disabled={!!current()?.recipe}
                    value={value().directory}
                    onInput={(event) => change({ directory: event.currentTarget.value })}
                  />
                </label>
                <div class="project-controls">
                  <Show when={props.pickDirectory && !current()?.recipe}>
                    <button
                      class="project-button"
                      type="button"
                      disabled={busy()}
                      onClick={() => {
                        const editing = draft()
                        const api = props.api
                        props.pickDirectory?.((directory) => {
                          if (props.api === api && draft() === editing) change({ directory })
                        })
                      }}
                    >
                      {t("projects.browse")}
                    </button>
                  </Show>
                  <button
                    class="project-button"
                    type="button"
                    disabled={busy() || !value().directory || !!current()?.recipe}
                    onClick={() => change({ directory: "" })}
                  >
                    {t("projects.clearDirectory")}
                  </button>
                </div>
                <p class="project-help">{t("projects.directoryHint")}</p>
                <div class="project-section-heading">
                  <h3>{t("projects.plan")}</h3>
                  <span>{t("projects.phases", { count: value().phases.length })}</span>
                </div>
                <p class="project-help">{t("projects.planHint")}</p>
                <ol class="project-phase-editor">
                  <Index each={value().phases}>
                    {(phase, index) => (
                      <li>
                        <span class="project-phase-number">{String(index + 1).padStart(2, "0")}</span>
                        <input
                          type="checkbox"
                          checked={phase().status === "complete"}
                          aria-label={t("projects.phaseComplete", { phase: index + 1 })}
                          onChange={(event) =>
                            phaseChange(index, { status: event.currentTarget.checked ? "complete" : "pending" })
                          }
                        />
                        <input
                          class="project-field"
                          required
                          maxLength={160}
                          aria-label={t("projects.phaseName", { phase: index + 1 })}
                          value={phase().name}
                          onInput={(event) => phaseChange(index, { name: event.currentTarget.value })}
                        />
                        <div class="project-phase-actions">
                          <button
                            type="button"
                            disabled={index === 0}
                            aria-label={t("projects.moveUp", { phase: index + 1 })}
                            onClick={() => movePhase(index, -1)}
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            disabled={index === value().phases.length - 1}
                            aria-label={t("projects.moveDown", { phase: index + 1 })}
                            onClick={() => movePhase(index, 1)}
                          >
                            ↓
                          </button>
                          <button
                            type="button"
                            aria-label={t("projects.removePhase", { phase: index + 1 })}
                            onClick={() => change({ phases: value().phases.filter((_, i) => i !== index) })}
                          >
                            ×
                          </button>
                        </div>
                      </li>
                    )}
                  </Index>
                </ol>
                <button
                  class="project-button"
                  type="button"
                  disabled={value().phases.length >= 256}
                  onClick={() =>
                    change({ phases: [...value().phases, { id: crypto.randomUUID(), name: "", status: "pending" }] })
                  }
                >
                  <Icon name="plus" size="small" />
                  {t("projects.addPhase")}
                </button>
                <div class="project-editor-footer">
                  <button
                    class="project-button primary"
                    type="submit"
                    disabled={
                      busy() ||
                      !value().name.trim() ||
                      !value().objective.trim() ||
                      value().phases.some((phase) => !phase.name.trim())
                    }
                  >
                    {busy() ? t("projects.saving") : t("projects.save")}
                  </button>
                  <Show when={dirty()}>
                    <span>{t("projects.unsaved")}</span>
                  </Show>
                </div>
              </form>
            </section>
          )}
        </Show>
        <Show when={!draft() && current()}>
          {(project) => (
            <section class="project-detail" aria-label={t("projects.details")}>
              <div class="project-detail-heading">
                <span class="project-state" data-state={state(project())}>
                  {stateLabel(project())}
                </span>
                <button class="project-button" onClick={() => void open()} aria-label={t("projects.close")}>
                  ×
                </button>
              </div>
              <h2 class="project-detail-title">{project().name}</h2>
              <p class="project-objective">{project().objective}</p>
              <div class="project-primary-actions">
                <Show when={project().recipe && props.onLaunch && deployment(project())?.state === "ready"}>
                  <button
                    class="project-button primary"
                    disabled={!!props.opening || props.launchUnavailable}
                    onClick={() => void props.onLaunch?.(project())}
                  >
                    {props.opening === project().id ? "Opening…" : "Open result"}
                  </button>
                </Show>
                <Show when={project().recipe && props.officerLink}>
                  {(unused) => (
                    <A
                      class={`project-button ${deployment(project())?.state === "ready" ? "" : "primary"}`}
                      href={props.officerLink!(project().recipe!.manager)}
                    >
                      Talk to Manager
                    </A>
                  )}
                </Show>
                <Show when={project().recipe && props.launchUnavailable}>
                  <span class="project-help" role="status">
                    Result status unavailable — reconnecting.
                  </span>
                </Show>
              </div>
              <Show when={project().paused}>
                <p class="project-pause-note">
                  Team paused
                  {deployment(project())?.state === "ready"
                    ? " · Your result is ready to use."
                    : ". Resume from Project details."}
                </p>
              </Show>
              <div class="project-section-heading">
                <h3>{t("projects.plan")}</h3>
                <span>
                  {project().completedPhases} / {project().totalPhases}
                </span>
              </div>
              <ol class="project-plan">
                <For each={project().phases}>
                  {(phase, index) => (
                    <li data-complete={phase.status === "complete"}>
                      <label>
                        <Show
                          when={props.advanced}
                          fallback={
                            <span
                              class="project-phase-mark"
                              aria-label={phase.status === "complete" ? "Complete" : "Pending"}
                            >
                              {phase.status === "complete" ? "✓" : String(index() + 1).padStart(2, "0")}
                            </span>
                          }
                        >
                          <input
                            type="checkbox"
                            disabled={busy()}
                            checked={phase.status === "complete"}
                            onChange={(event) =>
                              void execute({
                                op: "phase",
                                id: project().id,
                                phaseID: phase.id,
                                status: event.currentTarget.checked ? "complete" : "pending",
                              })
                            }
                          />
                        </Show>
                        <span>{phase.name}</span>
                        <small>{phase.status === "complete" ? t("projects.complete") : t("projects.pending")}</small>
                      </label>
                    </li>
                  )}
                </For>
              </ol>
              <Show when={!project().phases.length}>
                <p class="project-help">{t("projects.noPhases")}</p>
              </Show>
              <div class="project-section-heading">
                <h3>{t("projects.team")}</h3>
                <span>
                  {t("projects.teamCount", { working: project().workingOfficers, total: project().totalOfficers })}
                </span>
              </div>
              <Show when={project().recipe}>
                <p class="project-help">The Manager reports to Nova. Officers report to their Manager.</p>
              </Show>
              <ul class="project-officers">
                <For
                  each={officers()
                    .filter((officer) => officer.projectID === project().id)
                    .toSorted(
                      (a, b) => Number(b.id === project().recipe?.manager) - Number(a.id === project().recipe?.manager),
                    )}
                >
                  {(officer) => (
                    <li
                      classList={{
                        "project-team-lead": officer.id === project().recipe?.manager,
                        "project-team-member": !!project().recipe && officer.id !== project().recipe?.manager,
                      }}
                    >
                      <Show
                        when={props.portrait}
                        fallback={
                          <span class="project-officer-glyph" aria-hidden="true">
                            {officer.name.slice(0, 1)}
                          </span>
                        }
                      >
                        {(portrait) => portrait()(officer)}
                      </Show>
                      <div>
                        <Show when={props.officerLink} fallback={<strong>{officer.name}</strong>}>
                          {(link) => (
                            <A href={link()(officer.id)} aria-label={`Talk to ${officer.name}`}>
                              <strong>{officer.name}</strong>
                            </A>
                          )}
                        </Show>
                        <small>
                          {officer.title} ·{" "}
                          {officer.paused
                            ? t("projects.individuallyPaused")
                            : officer.working
                              ? t("projects.working")
                              : t("projects.ready")}
                        </small>
                      </div>
                      <Show when={props.advanced && !project().recipe?.officers.includes(officer.id)}>
                        <button
                          class="project-button"
                          disabled={busy()}
                          aria-label={t("projects.releaseOfficer", { name: officer.name })}
                          onClick={() => void execute({ op: "assign", officer: officer.id, projectID: null })}
                        >
                          ×
                        </button>
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
              <Show when={props.advanced}>
                <SelectV2
                  class="project-assign"
                  aria-label={t("projects.assign")}
                  placeholder={t("projects.assign")}
                  disabled={busy()}
                  options={officers().filter(
                    (officer) =>
                      officer.projectID !== project().id &&
                      !projects().some((item) => item.recipe?.officers.includes(officer.id)),
                  )}
                  current={undefined}
                  value={(officer) => officer.id}
                  label={(officer) =>
                    `${officer.name} — ${officer.title}${officer.projectID ? ` (${projects().find((row) => row.id === officer.projectID)?.name ?? ""})` : ""}`
                  }
                  onSelect={(officer) => {
                    if (officer) void execute({ op: "assign", officer: officer.id, projectID: project().id })
                  }}
                />
              </Show>
              <details class="project-more">
                <summary>Project details</summary>
                <div class="project-controls">
                  <button
                    class="project-button"
                    disabled={busy()}
                    onClick={() => void execute({ op: "pause", id: project().id, paused: !project().paused })}
                  >
                    {project().paused ? t("projects.resume") : t("projects.pause")}
                  </button>
                  <button class="project-button" disabled={busy()} onClick={() => void edit(project())}>
                    {t("projects.edit")}
                  </button>
                </div>

                <p class="project-help">{t("projects.pauseHint")}</p>
                <Show when={project().recipe}>
                  {(recipe) => (
                    <A class="project-recipe-link" href={`/recipes?recipe=${encodeURIComponent(recipe().slug)}`}>
                      Open recipe in Studio
                    </A>
                  )}
                </Show>
                <Show when={project().directory}>
                  <p class="project-directory">
                    <strong>{t("projects.directory")}</strong>
                    <br />
                    {project().directory}
                  </p>
                </Show>
                <button class="project-button danger" disabled={busy()} onClick={() => void remove(project())}>
                  {project().recipe ? "Undeploy" : t("projects.delete")}
                </button>
              </details>
            </section>
          )}
        </Show>
      </div>
    </AppPage>
  )
}
