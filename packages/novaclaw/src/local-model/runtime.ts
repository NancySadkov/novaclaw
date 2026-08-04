import path from "node:path"
import fs from "node:fs/promises"
import os from "node:os"
import { Cause, Effect, Fiber, Layer } from "effect"
import { HttpClient } from "effect/unstable/http"
import extract from "extract-zip"
import type { ConfigLocalModelCatalog } from "@novaclaw/core/config/local-model-catalog"
import { Download } from "@novaclaw/core/download"
import { FSUtil } from "@novaclaw/core/fs-util"
import { Global } from "@novaclaw/core/global"
import { LocalModelManager } from "@novaclaw/core/local-model-manager"
import { makeGlobalNode } from "@novaclaw/core/effect/app-node"
import { httpClient } from "@novaclaw/core/effect/app-node-platform"
import { Pressure } from "@/storage/pressure"
import { Process } from "@/util/process"
import {
  effective,
  evaluatePreflight,
  MODEL_ARTIFACT,
  outputForContext,
  type Preflight,
  type Profile,
  QWEN_PROFILE,
  recommendedContext,
  RUNTIME_ARTIFACT,
  supportedContext,
} from "./catalog"

const PORT = 11_343
const HOST = "127.0.0.1"

export type Stage =
  | "idle"
  | "checking"
  | "downloading-runtime"
  | "installing-runtime"
  | "downloading-model"
  | "installed"
  | "starting"
  | "ready"
  | "stopping"
  | "error"

export interface Status {
  readonly supported: boolean
  readonly platform: string
  readonly profiles: readonly Profile[]
  readonly stage: Stage
  readonly profileID?: string
  readonly completed?: number
  readonly total?: number
  readonly message?: string
  readonly detail?: string
  readonly baseURL?: string
  readonly modelID?: string
  readonly context?: number
  readonly output?: number
  readonly pid?: number
  readonly ramBytes?: number
  readonly preflight?: Preflight
  readonly recommendedContext: number
}

interface Paths {
  readonly root: string
  readonly runtimeArchive: string
  readonly runtimeRoot: string
  readonly server: string
  readonly modelRoot: string
  readonly model: string
  readonly selected: string
}

function localPaths(global: Global.Interface): Paths {
  const root = path.join(global.data, "local-models")
  const runtimeRoot = path.join(global.bin, "llama.cpp", RUNTIME_ARTIFACT.version, "win-vulkan-x64")
  return {
    root,
    runtimeArchive: path.join(global.cache, "local-models", `llama-${RUNTIME_ARTIFACT.version}-win-vulkan-x64.zip`),
    runtimeRoot,
    server: path.join(runtimeRoot, "llama-server.exe"),
    modelRoot: path.join(root, QWEN_PROFILE.id),
    model: path.join(root, QWEN_PROFILE.id, MODEL_ARTIFACT.filename),
    selected: path.join(root, "selected.json"),
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

async function exists(file: string): Promise<boolean> {
  return fs.stat(file).then(
    () => true,
    () => false,
  )
}

async function preflight(paths: Paths, context: number, profile: Profile): Promise<Preflight> {
  const [memory, modelPresent, runtimePresent] = await Promise.all([
    Pressure.memory(),
    exists(paths.model),
    exists(paths.server),
  ])
  const disk = Pressure.disk(paths.root)
  return evaluatePreflight({
    memory,
    disk,
    modelPresent,
    runtimePresent,
    context,
    physicalMemoryBytes: os.totalmem(),
    profile,
  })
}

function baseStatus(profile: Profile): Pick<Status, "supported" | "platform" | "profiles" | "recommendedContext"> {
  return {
    supported: process.platform === "win32" && process.arch === "x64",
    platform: `${process.platform}-${process.arch}`,
    profiles: [profile],
    recommendedContext: recommendedContext(os.totalmem()),
  }
}

export function isManagedEndpoint(value: string | undefined): boolean {
  if (!value || !URL.canParse(value)) return false
  const url = new URL(value)
  const host = url.hostname === "localhost" ? HOST : url.hostname
  return (
    url.protocol === "http:" &&
    host === HOST &&
    Number(url.port || "80") === PORT &&
    url.pathname.replace(/\/+$/, "") === "/v1"
  )
}

async function waitUntilReady(child: Process.Child, expectedModel: string, timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`llama.cpp stopped during startup (exit code ${child.exitCode}).`)
    try {
      const response = await fetch(`http://${HOST}:${PORT}/v1/models`, { signal: AbortSignal.timeout(2_000) })
      if (response.ok) {
        const body = (await response.json()) as { data?: Array<{ id?: string }> }
        if (body.data?.some((entry) => entry.id === expectedModel)) return
      }
    } catch {
      // Loading a model can take a while. The bounded loop reports one useful failure at the end.
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error("llama.cpp did not become ready within 3 minutes.")
}

export const layer = Layer.effect(
  LocalModelManager.Service,
  Effect.gen(function* () {
    const global = yield* Global.Service
    const paths = localPaths(global)
    const runtime = Effect.runForkWith(yield* Effect.context<Global.Service | FSUtil.Service | HttpClient.HttpClient>())
    let acquisition = effective()
    let state: Status = { ...baseStatus(acquisition.profile), stage: "idle" }
    let job: Fiber.Fiber<void, never> | undefined
    let child: Process.Child | undefined
    let shuttingDown = false
    let expectedStop = false
    let recentLog = ""
    let selectedContext = recommendedContext(os.totalmem())
    let pressureTimer: ReturnType<typeof setInterval> | undefined

    const set = (next: Partial<Status>) => {
      state = { ...state, ...next }
    }
    const log = (chunk: unknown) => {
      recentLog = `${recentLog}${String(chunk)}`.slice(-8_000)
    }

    const launch = (gpu: boolean, signal?: AbortSignal) =>
      Effect.promise(async () => {
        set({
          stage: "starting",
          message: gpu ? "Starting the local model…" : "Starting in CPU mode…",
          completed: undefined,
          total: undefined,
        })
        recentLog = ""
        const next = Process.spawn(
          [
            paths.server,
            "--model",
            paths.model,
            "--alias",
            QWEN_PROFILE.modelID,
            "--host",
            HOST,
            "--port",
            String(PORT),
            "--ctx-size",
            String(selectedContext),
            "--parallel",
            "1",
            "--gpu-layers",
            gpu ? "all" : "0",
            "--jinja",
            "--no-webui",
          ],
          { stdout: "pipe", stderr: "pipe", abort: signal },
        )
        child = next
        set({ pid: next.pid, ramBytes: undefined })
        next.stdout?.on("data", log)
        next.stderr?.on("data", log)
        try {
          await waitUntilReady(next, QWEN_PROFILE.modelID)
          const memory = await Pressure.memory()
          if (Pressure.memoryLevel(memory, Pressure.DEFAULT_THRESHOLDS) === "floor") {
            if (memory.known)
              throw new Error(
                `Starting the local model used ${(memory.usedBytes / 1024 ** 3).toFixed(1)} GB of ` +
                  `${(memory.limitBytes / 1024 ** 3).toFixed(1)} GB committed memory. NovaClaw stopped it ` +
                  `before the computer ran out. Close memory-heavy apps or choose the 32K context.`,
              )
            throw new Error("Starting the local model left this computer at its configured memory safety floor.")
          }
        } catch (error) {
          await Process.stop(next).catch(() => undefined)
          if (child === next) child = undefined
          throw error
        }
        set({
          stage: "ready",
          message: "Qwen3.5 4B is loaded and ready.",
          detail: undefined,
          baseURL: `http://${HOST}:${PORT}/v1`,
          modelID: QWEN_PROFILE.modelID,
          context: selectedContext,
          output: outputForContext(selectedContext),
          pid: next.pid,
        })
        let monitor: ReturnType<typeof setInterval> | undefined
        void next.exited.then((code) => {
          if (monitor) clearInterval(monitor)
          if (pressureTimer === monitor) pressureTimer = undefined
          if (child === next) child = undefined
          const wasExpected = expectedStop
          expectedStop = false
          if (!shuttingDown && !wasExpected && state.stage === "ready")
            set({
              stage: "error",
              message: "The local model stopped.",
              detail: `${recentLog.trim().slice(-2_000) || `llama.cpp exited with code ${code}.`} Try starting it again.`,
              pid: undefined,
              ramBytes: undefined,
            })
          else if (!shuttingDown && wasExpected)
            set({
              stage: "installed",
              message: "The local model is stopped. It will load again when you prompt it.",
              pid: undefined,
              ramBytes: undefined,
            })
        })
        monitor = setInterval(() => {
          void Promise.all([Pressure.memory(), Pressure.processMemory(next.pid)]).then(([memory, processMemory]) => {
            if (child === next && processMemory.known) set({ ramBytes: processMemory.rssBytes })
            if (child !== next || Pressure.memoryLevel(memory, Pressure.DEFAULT_THRESHOLDS) !== "floor") return
            const detail = memory.known
              ? `Committed memory reached ${(memory.usedBytes / 1024 ** 3).toFixed(1)} GB of ` +
                `${(memory.limitBytes / 1024 ** 3).toFixed(1)} GB. NovaClaw stopped the local model before ` +
                `the computer ran out. Close memory-heavy apps or restart it with the 32K context.`
              : "NovaClaw stopped the local model because the host reached its configured memory safety floor."
            set({ stage: "error", message: "The local model was stopped to protect this computer.", detail })
            void Process.stop(next).catch(() => undefined)
          })
        }, 5_000)
        pressureTimer = monitor
        pressureTimer.unref?.()
      })

    const install = Effect.gen(function* () {
      const selected = acquisition
      set({
        ...baseStatus(selected.profile),
        stage: "checking",
        profileID: QWEN_PROFILE.id,
        context: selectedContext,
        output: outputForContext(selectedContext),
        message: "Checking this computer…",
        detail: undefined,
        baseURL: undefined,
        modelID: undefined,
        completed: undefined,
        total: undefined,
      })
      const check = yield* Effect.promise(() => preflight(paths, selectedContext, selected.profile))
      set({ preflight: check })
      if (!check.ok) throw new Error(check.issues.join(" "))

      if (!(yield* Effect.promise(() => exists(paths.server)))) {
        set({ stage: "downloading-runtime", message: "Downloading the local AI engine…" })
        yield* Download.toFile({
          url: selected.runtime.url,
          destination: paths.runtimeArchive,
          integrity: { sha256: selected.runtime.sha256 },
          retries: 3,
          preservePartialOnInterrupt: true,
          onProgress: ({ completed, total }) => Effect.sync(() => set({ completed, total })),
        })
        set({
          stage: "installing-runtime",
          message: "Installing the local AI engine…",
          completed: undefined,
          total: undefined,
        })
        yield* Effect.promise(async () => {
          const staging = `${paths.runtimeRoot}.installing`
          await fs.rm(staging, { recursive: true, force: true })
          await fs.mkdir(staging, { recursive: true })
          await extract(paths.runtimeArchive, { dir: staging })
          if (!(await exists(path.join(staging, "llama-server.exe"))))
            throw new Error("The verified llama.cpp archive did not contain llama-server.exe.")
          await fs.rm(paths.runtimeRoot, { recursive: true, force: true })
          await fs.mkdir(path.dirname(paths.runtimeRoot), { recursive: true })
          await fs.rename(staging, paths.runtimeRoot)
        })
      }

      if (!(yield* Effect.promise(() => exists(paths.model)))) {
        set({
          stage: "downloading-model",
          message: "Downloading Qwen3.5 4B…",
          completed: 0,
          total: selected.profile.downloadBytes,
        })
        yield* Download.toFile({
          url: selected.model.url,
          destination: paths.model,
          integrity: { sha256: selected.model.sha256 },
          retries: 3,
          stallTimeout: "60 seconds",
          preservePartialOnInterrupt: true,
          onProgress: ({ completed, total }) => Effect.sync(() => set({ completed, total })),
        })
      }

      yield* Effect.promise(async () => {
        await fs.mkdir(paths.root, { recursive: true })
        await fs.writeFile(
          paths.selected,
          `${JSON.stringify({ profileID: QWEN_PROFILE.id, context: selectedContext, selectedAt: Date.now() }, null, 2)}\n`,
          "utf8",
        )
      })
      set({
        stage: "installed",
        message: "Qwen3.5 4B is installed. It will load when you send it a prompt.",
        detail: undefined,
        completed: undefined,
        total: undefined,
        baseURL: `http://${HOST}:${PORT}/v1`,
        modelID: QWEN_PROFILE.modelID,
        context: selectedContext,
        output: outputForContext(selectedContext),
      })
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          const message = errorText(Cause.squash(cause))
          set({
            stage: "error",
            message: "The local model could not be installed.",
            detail: `${message}${recentLog.trim() ? `\n\nllama.cpp: ${recentLog.trim().slice(-2_000)}` : ""}`,
          })
        }),
      ),
    )

    const installModel = (profileID: string, context?: number, overrides?: ConfigLocalModelCatalog.Info) =>
      Effect.sync(() => {
        if (!state.supported) {
          set({
            stage: "error",
            profileID,
            message: "Managed local models are not available on this build yet.",
            detail: `This first tested release supports Windows x64; this instance is ${process.platform}-${process.arch}.`,
          })
          return state
        }
        if (profileID !== QWEN_PROFILE.id) {
          set({ stage: "error", profileID, message: "That local model is not in this NovaClaw catalog." })
          return state
        }
        if (context !== undefined && !QWEN_PROFILE.contexts.includes(context)) {
          set({
            stage: "error",
            profileID,
            message: "That context size is not available for this local model.",
            detail: `Choose ${QWEN_PROFILE.contexts.map((value) => `${value / 1024}K`).join(" or ")}.`,
          })
          return state
        }
        if (
          state.stage === "downloading-runtime" ||
          state.stage === "installing-runtime" ||
          state.stage === "downloading-model" ||
          state.stage === "starting" ||
          state.stage === "checking"
        )
          return state
        acquisition = effective(overrides)
        selectedContext = context ?? recommendedContext(os.totalmem())
        set({
          stage: "checking",
          profileID,
          context: selectedContext,
          output: outputForContext(selectedContext),
          message: "Checking this computer…",
        })
        job = runtime(
          Effect.gen(function* () {
            if (child) {
              expectedStop = true
              yield* Effect.promise(() => Process.stop(child!).catch(() => undefined))
              Pressure.resetMemoryCache()
            }
            yield* install
          }),
        )
        return state
      })

    let loading: Promise<void> | undefined
    let loadAbort: AbortController | undefined

    const loadModel = (signal: AbortSignal) =>
      Effect.gen(function* () {
        // One managed engine owns one loaded model. Release the previous context/model BEFORE the
        // admission check; otherwise its own RAM makes the replacement look impossible to load.
        if (child) {
          expectedStop = true
          yield* Effect.promise(() => Process.stop(child!).catch(() => undefined))
          Pressure.resetMemoryCache()
        }
        const check = yield* Effect.promise(() => preflight(paths, selectedContext, acquisition.profile))
        set({ preflight: check })
        if (!check.ok) return yield* Effect.fail(new Error(check.issues.join(" ")))
        if (!(yield* Effect.promise(() => exists(paths.server))) || !(yield* Effect.promise(() => exists(paths.model))))
          return yield* Effect.fail(
            new Error("This local model is not installed. Open Settings → Models → Add model → Local Model first."),
          )
        yield* launch(true, signal).pipe(
          Effect.catch((gpuError) =>
            Effect.gen(function* () {
              const retryCheck = yield* Effect.promise(() => preflight(paths, selectedContext, acquisition.profile))
              if (!retryCheck.ok) return yield* Effect.fail(gpuError)
              set({ detail: `Graphics acceleration was unavailable (${errorText(gpuError)}). Retrying on the CPU.` })
              return yield* launch(false, signal)
            }),
          ),
        )
      })

    const ensure = (request: LocalModelManager.ModelRequest, overrides?: ConfigLocalModelCatalog.Info) => {
      if (!isManagedEndpoint(request.baseURL) || request.apiModelID !== QWEN_PROFILE.modelID) return Effect.void
      return Effect.tryPromise({
        try: async () => {
          if (!state.supported)
            throw new Error(`Managed local models are not available on ${process.platform}-${process.arch} yet.`)
          acquisition = effective(overrides)
          const requestedContext = request.context
          if (requestedContext !== undefined && supportedContext(requestedContext)) selectedContext = requestedContext
          if (state.stage === "ready" && child && state.context === selectedContext) return
          if (!loading) {
            loadAbort = new AbortController()
            const controller = loadAbort
            loading = Effect.runPromise(loadModel(controller.signal))
              .catch((cause) => {
                const detail = errorText(cause)
                if (!controller.signal.aborted)
                  set({
                    stage: "error",
                    message: "The local model could not be loaded.",
                    detail: `${detail}${recentLog.trim() ? `\n\nllama.cpp: ${recentLog.trim().slice(-2_000)}` : ""}`,
                    pid: undefined,
                    ramBytes: undefined,
                  })
                throw cause
              })
              .finally(() => {
                if (loadAbort === controller) loadAbort = undefined
                loading = undefined
              })
          }
          await loading
        },
        catch: (cause) =>
          new LocalModelManager.UnavailableError({
            message:
              `The managed local model could not be loaded: ${errorText(cause)} ` +
              "Open Settings → Instances for memory details and controls, or pick another model.",
          }),
      })
    }

    const stop = () =>
      Effect.promise(async () => {
        if (!child && !loading) {
          if ((await exists(paths.server)) && (await exists(paths.model)))
            set({
              stage: "installed",
              message: "The local model is stopped. It will load again when you prompt it.",
              detail: undefined,
              pid: undefined,
              ramBytes: undefined,
            })
          return state
        }
        set({ stage: "stopping", message: "Stopping the local model…" })
        expectedStop = true
        loadAbort?.abort(new Error("The local model was stopped from Instance settings."))
        const current = child
        if (current) await Process.stop(current).catch(() => undefined)
        await loading?.catch(() => undefined)
        if (!child)
          set({
            stage: "installed",
            message: "The local model is stopped. It will load again when you prompt it.",
            pid: undefined,
            ramBytes: undefined,
          })
        return state
      })

    const status = (overrides?: ConfigLocalModelCatalog.Info) =>
      Effect.promise(async () => {
        if (
          state.stage === "idle" ||
          state.stage === "installed" ||
          state.stage === "ready" ||
          state.stage === "error"
        ) {
          acquisition = effective(overrides)
          set({
            ...baseStatus(acquisition.profile),
            context: selectedContext,
            preflight: await preflight(paths, selectedContext, acquisition.profile),
          })
        }
        return state
      })

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        shuttingDown = true
        loadAbort?.abort()
        if (pressureTimer) clearInterval(pressureTimer)
        if (job) await Effect.runPromise(Fiber.interrupt(job)).catch(() => undefined)
        if (child) await Process.stop(child).catch(() => undefined)
      }),
    )

    if (yield* Effect.promise(() => exists(paths.selected))) {
      const saved = yield* Effect.promise(() =>
        fs
          .readFile(paths.selected, "utf8")
          .then((text) => JSON.parse(text) as { context?: unknown })
          .catch((): { context?: unknown } => ({})),
      )
      if (typeof saved.context === "number" && supportedContext(saved.context)) selectedContext = saved.context
      const complete =
        (yield* Effect.promise(() => exists(paths.server))) && (yield* Effect.promise(() => exists(paths.model)))
      if (complete) {
        set({
          stage: "installed",
          profileID: QWEN_PROFILE.id,
          message: "Qwen3.5 4B is installed. It will load when you send it a prompt.",
          baseURL: `http://${HOST}:${PORT}/v1`,
          modelID: QWEN_PROFILE.modelID,
          context: selectedContext,
          output: outputForContext(selectedContext),
        })
      } else {
        set({
          stage: "error",
          profileID: QWEN_PROFILE.id,
          message: "The local model installation is incomplete. Install it again to repair the missing files.",
          context: selectedContext,
          output: outputForContext(selectedContext),
          detail: "One or more local model files are missing.",
        })
      }
    }

    return LocalModelManager.Service.of({ status, install: installModel, ensure, stop })
  }),
)

export const node = makeGlobalNode({
  service: LocalModelManager.Service,
  layer,
  deps: [Global.node, FSUtil.node, httpClient],
})

export * as LocalModelRuntime from "./runtime"
export { QWEN_PROFILE_ID } from "./catalog"
export type { Profile, Preflight } from "./catalog"
