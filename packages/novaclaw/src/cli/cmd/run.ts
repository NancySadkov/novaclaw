import type { PermissionRuleset } from "@novaclaw/schema/permission-ruleset"
import { FSUtil } from "@novaclaw/core/fs-util"
// CLI entry point for `novaclaw run` — the headless, non-interactive runner.
//
// Sends a single prompt, streams the session's events to stdout, and exits when
// the session goes idle. The prompt is delivered via the async `promptAsync`
// endpoint (the V2/V1 router), so the process blocks on the idle event from the
// event stream rather than on a synchronous response body. With `--attach` it
// drives a running novaclaw server; otherwise it runs an in-process one.
//
// Also supports `--command` for slash-command execution (still the blocking
// legacy endpoint — there is no async variant), `--format json` for raw event
// streaming, `--continue` / `--session` for session resumption, and `--fork`
// for forking before continuing.
import type { Argv } from "yargs"
import path from "path"
import { pathToFileURL } from "url"
import { open } from "node:fs/promises"
import { Effect } from "effect"
import { UI } from "../ui"
import { effectCmd } from "../effect-cmd"
import { EOL } from "os"
import { Filesystem } from "@/util/filesystem"
import { createNovaclawClient, type NovaclawClient } from "@novaclaw/sdk/v2"
import type { ToolPart } from "./run/types"
import { FormatError, FormatUnknownError } from "../error"

type ModelInput = string

function pick(value: string | undefined): ModelInput | undefined {
  // The native switch takes the "providerID/modelID" ref string apart itself at the call site.
  return value || undefined
}

function resolveRunInput(value?: string, piped?: string): string | undefined {
  if (!value) {
    return piped
  }

  if (!piped) {
    return value
  }

  return value + "\n" + piped
}

// Read piped stdin for the prompt. A non-TTY stdin held OPEN but silent — CI wrappers and
// process runners that spawn with a pipe and never write or close it — parks
// `Bun.stdin.text()` forever waiting for EOF, hanging the whole run before any output
// (the test harness works around it with stdin:"ignore"; real callers hit it). When a
// message argument already exists, stdin is OPTIONAL extra input: give a real pipe a
// short grace window (an actual `echo x | novaclaw run "y"` delivers EOF well within it)
// and proceed without stdin if nothing arrives. With no message argument, stdin is the
// only input source — block until EOF as before.
const PIPED_INPUT_GRACE_MS = 250

async function readPipedInput(hasMessage: boolean): Promise<string | undefined> {
  if (process.stdin.isTTY) return undefined
  const read = Bun.stdin.text()
  if (!hasMessage) return read
  return Promise.race([
    read,
    new Promise<undefined>((resolve) => {
      const timer = setTimeout(() => resolve(undefined), PIPED_INPUT_GRACE_MS)
      timer.unref?.()
    }),
  ])
}

type FilePart = {
  type: "file"
  url: string
  filename: string
  mime: string
}

const ATTACH_FILE_MAX_BYTES = 10 * 1024 * 1024

type Inline = {
  icon: string
  title: string
  description?: string
}

type SessionInfo = {
  id: string
  title?: string
  directory?: string
}

function inline(info: Inline) {
  const suffix = info.description ? UI.Style.TEXT_DIM + ` ${info.description}` + UI.Style.TEXT_NORMAL : ""
  UI.println(UI.Style.TEXT_NORMAL + info.icon, UI.Style.TEXT_NORMAL + info.title + suffix)
}

function block(info: Inline, output?: string) {
  UI.empty()
  inline(info)
  if (!output?.trim()) return
  UI.println(output)
  UI.empty()
}

function formatRunError(error: unknown) {
  return FormatError(error) ?? FormatUnknownError(error)
}

async function tool(part: ToolPart) {
  try {
    const { toolInlineInfo } = await import("./run/tool")
    const next = toolInlineInfo(part)
    if (next.mode === "block") {
      block(next, next.body)
      return
    }

    inline(next)
  } catch {
    inline({
      icon: "\u2699",
      title: part.tool,
    })
  }
}

async function toolError(part: ToolPart) {
  try {
    const { toolInlineInfo } = await import("./run/tool")
    const next = toolInlineInfo(part)
    inline({
      icon: "✗",
      title: `${next.title} failed`,
      ...(next.description && { description: next.description }),
    })
    return
  } catch {
    inline({
      icon: "✗",
      title: `${part.tool} failed`,
    })
  }
}

export const RunCommand = effectCmd({
  command: "run [message..]",
  describe: "run novaclaw with a message",
  // --attach connects to a remote server (no local instance needed); the
  // default path runs an in-process server and needs the project instance.
  instance: (args) => !args.attach,
  // For --dir without --attach, load instance for the resolved target dir.
  // The handler also chdirs (preserving the legacy order: chdir → file resolution).
  directory: (args) => (args.dir && !args.attach ? path.resolve(process.cwd(), args.dir) : process.cwd()),
  builder: (yargs: Argv) =>
    yargs
      .positional("message", {
        describe: "message to send",
        type: "string",
        array: true,
        default: [],
      })
      .option("command", {
        describe: "the command to run, use message for args",
        type: "string",
      })
      .option("continue", {
        alias: ["c"],
        describe: "continue the last session",
        type: "boolean",
      })
      .option("session", {
        alias: ["s"],
        describe: "session id to continue",
        type: "string",
      })
      .option("fork", {
        describe: "fork the session before continuing (requires --continue or --session)",
        type: "boolean",
      })
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: "model to use in the format of provider/model",
      })
      .option("agent", {
        type: "string",
        describe: "agent to use",
      })
      .option("format", {
        type: "string",
        choices: ["default", "json"],
        default: "default",
        describe: "format: default (formatted) or json (raw JSON events)",
      })
      .option("file", {
        alias: ["f"],
        type: "string",
        array: true,
        describe: "file(s) to attach to message",
      })
      .option("title", {
        type: "string",
        describe: "title for the session (uses truncated prompt if no value provided)",
      })
      .option("attach", {
        type: "string",
        describe: "attach to a running novaclaw server (e.g., http://localhost:4096)",
      })
      .option("password", {
        alias: ["p"],
        type: "string",
        describe: "basic auth password (defaults to NOVACLAW_SERVER_PASSWORD)",
      })
      .option("username", {
        alias: ["u"],
        type: "string",
        describe: "basic auth username (defaults to NOVACLAW_SERVER_USERNAME or 'novaclaw')",
      })
      .option("dir", {
        type: "string",
        describe: "directory to run in, path on remote server if attaching",
      })
      .option("port", {
        type: "number",
        describe: "port for the local server (defaults to random port if no value provided)",
      })
      .option("variant", {
        type: "string",
        describe: "model variant (provider-specific reasoning effort, e.g., high, max, minimal)",
      })
      .option("thinking", {
        type: "boolean",
        describe: "show thinking blocks",
      })
      .option("dangerously-skip-permissions", {
        type: "boolean",
        describe: "auto-approve permissions that are not explicitly denied (dangerous!)",
        default: false,
      }),
  handler: Effect.fn("Cli.run")(function* (args) {
    const { Agent } = yield* Effect.promise(() => import("@/agent/agent"))
    const { RuntimeFlags } = yield* Effect.promise(() => import("@/effect/runtime-flags"))
    const { InstanceRef } = yield* Effect.promise(() => import("@/effect/instance-ref"))
    const { ServerAuth } = yield* Effect.promise(() => import("@/server/auth"))
    const agentSvc = yield* Agent.Service
    const flags = yield* RuntimeFlags.Service
    const localInstance = yield* InstanceRef
    yield* Effect.promise(async () => {
      const thinking = args.thinking ?? false

      // Wall-clock watchdog: a one-shot run that wedges mid-turn (observed live — a stuck
      // await keeps the process alive indefinitely at ~1.5 GB, the OTHER half of the
      // issues.md P2 orphan generator) becomes a bounded failure instead of an immortal
      // orphan. Generous default; NOVACLAW_RUN_WALL_MS overrides for long agentic runs.
      const wallMs = Number(process.env["NOVACLAW_RUN_WALL_MS"]) || 45 * 60 * 1000
      const watchdog = setTimeout(() => {
        UI.error(`run exceeded its wall clock (${Math.round(wallMs / 60000)}m) — exiting`)
        process.exit(124)
      }, wallMs)
      // unref: the watchdog must never be the thing KEEPING the process alive.
      if (typeof watchdog === "object" && "unref" in watchdog) watchdog.unref()

      let message = [...args.message, ...(args["--"] || [])]
        .map((arg) => (arg.includes(" ") ? `"${arg.replace(/"/g, '\\"')}"` : arg))
        .join(" ")

      const root = Filesystem.resolve(process.env.PWD ?? process.cwd())
      const directory = (() => {
        if (!args.dir) return args.attach ? undefined : root
        if (args.attach) return args.dir

        try {
          process.chdir(path.isAbsolute(args.dir) ? args.dir : path.join(root, args.dir))
          return process.cwd()
        } catch {
          UI.error("Failed to change directory to " + args.dir)
          process.exit(1)
        }
      })()
      const attachHeaders = args.attach
        ? ServerAuth.headers({ password: args.password, username: args.username })
        : undefined
      const attachSDK = (dir?: string) => {
        return createNovaclawClient({
          baseUrl: args.attach!,
          directory: dir,
          headers: attachHeaders,
        })
      }

      const files: FilePart[] = []
      if (args.file) {
        const list = Array.isArray(args.file) ? args.file : [args.file]

        for (const filePath of list) {
          const resolvedPath = path.resolve(args.attach ? root : (directory ?? root), filePath)
          if (!(await Filesystem.exists(resolvedPath))) {
            UI.error(`File not found: ${filePath}`)
            process.exit(1)
          }

          const stat = Filesystem.stat(resolvedPath)
          const isDirectory = stat?.isDirectory() ?? false
          if (args.attach && isDirectory) {
            UI.error(`Cannot attach local directory without a shared filesystem: ${filePath}`)
            process.exit(1)
          }

          const content = await (async () => {
            if (!args.attach) return
            const handle = await open(resolvedPath, "r")
            try {
              const opened = await handle.stat()
              if (!opened.isFile() || Number(opened.size) > ATTACH_FILE_MAX_BYTES) {
                UI.error(`Cannot attach local file larger than 10 MiB or a special file: ${filePath}`)
                process.exit(1)
              }
              if (opened.size === 0) return Buffer.alloc(0)
              const buffer = Buffer.alloc(Number(opened.size))
              let offset = 0
              while (offset < buffer.length) {
                const read = await handle.read(buffer, offset, buffer.length - offset, offset)
                if (read.bytesRead === 0) break
                offset += read.bytesRead
              }
              return buffer.subarray(0, offset)
            } finally {
              await handle.close()
            }
          })()
          const detected = FSUtil.mimeType(resolvedPath)
          const text = content?.toString("utf8")
          const mime = !args.attach
            ? isDirectory
              ? "application/x-directory"
              : "text/plain"
            : content && text !== undefined && Buffer.from(text, "utf8").equals(content)
              ? "text/plain"
              : detected

          files.push({
            type: "file",
            url: content ? `data:${mime};base64,${content.toString("base64")}` : pathToFileURL(resolvedPath).href,
            filename: path.basename(resolvedPath),
            mime,
          })
        }
      }

      const piped = await readPipedInput(message.trim().length > 0)
      message = resolveRunInput(message, piped) ?? ""

      if (message.trim().length === 0 && !args.command) {
        UI.error("You must provide a message or a command")
        process.exit(1)
      }

      if (args.fork && !args.continue && !args.session) {
        UI.error("--fork requires --continue or --session")
        process.exit(1)
      }

      const rules: PermissionRuleset.Ruleset = [
        {
          permission: "question",
          action: "deny",
          pattern: "*",
        },
        {
          permission: "plan_enter",
          action: "deny",
          pattern: "*",
        },
        {
          permission: "plan_exit",
          action: "deny",
          pattern: "*",
        },
      ]

      function title() {
        if (args.title === undefined) return
        if (args.title !== "") return args.title
        return message.slice(0, 50) + (message.length > 50 ? "..." : "")
      }

      async function session(sdk: NovaclawClient): Promise<SessionInfo | undefined> {
        if (args.session) {
          const current = await sdk.v2.session
            .get({
              sessionID: args.session,
            })
            .catch(() => undefined)

          if (!current?.data?.data) {
            UI.error("Session not found")
            process.exit(1)
          }

          if (args.fork) {
            const forked = await sdk.v2.session.fork({
              sessionID: args.session,
            })
            const id = forked.data?.data?.id
            if (!id) {
              return
            }

            return {
              id,
              title: forked.data?.data?.title ?? current.data.data.title,
              directory: forked.data?.data?.location.directory ?? current.data.data.location.directory,
            }
          }

          return {
            id: current.data.data.id,
            title: current.data.data.title,
            directory: current.data.data.location.directory,
          }
        }

        const base = args.continue ? (await sdk.v2.session.list()).data?.data?.find((item) => !item.parentID) : undefined

        if (base && args.fork) {
          const forked = await sdk.v2.session.fork({
            sessionID: base.id,
          })
          const id = forked.data?.data?.id
          if (!id) {
            return
          }

          return {
            id,
            title: forked.data?.data?.title ?? base.title,
            directory: forked.data?.data?.location.directory ?? base.location.directory,
          }
        }

        if (base) {
          return {
            id: base.id,
            title: base.title,
            directory: base.location.directory,
          }
        }

        const name = title()
        const result = await sdk.v2.session.create({
          title: name,
          permission: [...rules],
        })
        const id = result.data?.data?.id
        if (!id) {
          return
        }

        return {
          id,
          title: result.data?.data?.title ?? name,
          directory: result.data?.data?.location.directory,
        }
      }

      async function current(sdk: NovaclawClient): Promise<string> {
        if (!args.attach) {
          return directory ?? root
        }

        const next = await sdk.path
          .get()
          .then((x) => x.data?.directory)
          .catch(() => undefined)
        if (next) {
          return next
        }

        UI.error("Failed to resolve remote directory")
        process.exit(1)
      }

      async function localAgent() {
        if (!args.agent) return undefined
        const name = args.agent

        const entry = await Effect.runPromise(
          agentSvc.get(name).pipe(Effect.provideService(InstanceRef, localInstance)),
        )
        if (!entry) {
          UI.println(
            UI.Style.TEXT_WARNING_BOLD + "!",
            UI.Style.TEXT_NORMAL,
            `agent "${name}" not found. Falling back to default agent`,
          )
          return undefined
        }
        if (entry.mode === "subagent") {
          UI.println(
            UI.Style.TEXT_WARNING_BOLD + "!",
            UI.Style.TEXT_NORMAL,
            `agent "${name}" is a subagent, not a primary agent. Falling back to default agent`,
          )
          return undefined
        }
        return name
      }

      async function attachAgent(sdk: NovaclawClient) {
        if (!args.agent) return undefined
        const name = args.agent

        const modes = await sdk.app
          .agents(undefined, { throwOnError: true })
          .then((x) => x.data ?? [])
          .catch(() => undefined)

        if (!modes) {
          UI.println(
            UI.Style.TEXT_WARNING_BOLD + "!",
            UI.Style.TEXT_NORMAL,
            `failed to list agents from ${args.attach}. Falling back to default agent`,
          )
          return undefined
        }

        const agent = modes.find((a) => a.name === name)
        if (!agent) {
          UI.println(
            UI.Style.TEXT_WARNING_BOLD + "!",
            UI.Style.TEXT_NORMAL,
            `agent "${name}" not found. Falling back to default agent`,
          )
          return undefined
        }

        if (agent.mode === "subagent") {
          UI.println(
            UI.Style.TEXT_WARNING_BOLD + "!",
            UI.Style.TEXT_NORMAL,
            `agent "${name}" is a subagent, not a primary agent. Falling back to default agent`,
          )
          return undefined
        }

        return name
      }

      async function pickAgent(sdk: NovaclawClient) {
        if (!args.agent) return undefined
        if (args.attach) {
          return attachAgent(sdk)
        }

        return localAgent()
      }

      async function execute(sdk: NovaclawClient) {
        const sess = await session(sdk)
        if (!sess?.id) {
          UI.error("Session not found")
          process.exit(1)
        }
        const sessionID = sess.id

        function emit(type: string, data: Record<string, unknown>) {
          if (args.format === "json") {
            process.stdout.write(
              JSON.stringify({
                type,
                timestamp: Date.now(),
                sessionID,
                ...data,
              }) + EOL,
            )
            return true
          }
          return false
        }

        // Consume one subscribed event stream for the active session and mirror it
        // to stdout/UI. `client` is passed explicitly because attach mode may
        // rebind the SDK to the session's directory after the subscription is
        // created, and replies issued from inside the loop must use that client.
        //
        // F1e S7-prep: the loop consumes the NATIVE `session.next.*` / `permission.v2.*`
        // vocab (terminal events carry full values — text.ended/reasoning.ended/
        // tool.success — so no delta folding is needed). The V1 projections it used to
        // read (`message.part.updated`, `permission.asked`, `session.error`) are no
        // longer consumed, unblocking the S7 translator/projection delete. Tool
        // rendering still rides run/tool.ts, fed a minimal ToolPart-shaped adapter.
        async function loop(client: NovaclawClient, events: Awaited<ReturnType<typeof sdk.event.subscribe>>) {
          const toggles = new Map<string, boolean>()
          // callID -> name+input captured at tool.called, joined with tool.success/failed.
          const calls = new Map<string, { tool: string; input: Record<string, unknown> }>()
          let error: string | undefined

          // Flatten native ToolContent[] into the flat output blob run/tool.ts renders
          // (text entries only — file entries carry no inline text).
          const flatten = (content: ReadonlyArray<{ type: string; text?: string }> | undefined) =>
            (content ?? [])
              .filter((item) => item.type === "text")
              .map((item) => item.text ?? "")
              .join("")

          const toolPart = (input: { callID: string; state: Record<string, unknown> & { status: string } }): ToolPart => {
            const entry = calls.get(input.callID)
            const name = entry?.tool ?? "unknown"
            return {
              type: "tool",
              id: input.callID,
              callID: input.callID,
              sessionID,
              tool: name,
              state: {
                input: entry?.input ?? {},
                title: name,
                ...input.state,
              },
            } as unknown as ToolPart
          }

          const fail = (message: string, raw: unknown) => {
            error = error ? error + EOL + message : message
            if (emit("error", { error: raw })) return
            UI.error(message)
          }

          const errorMessage = (err: unknown, fallback: string) => {
            if (err && typeof err === "object" && "message" in err) {
              const value = String((err as { message: unknown }).message)
              if (value) return value
            }
            return fallback
          }

          for await (const event of events.stream) {
            if (process.env["NOVACLAW_RUN_DEBUG_EVENTS"]) console.error("EVT", event.type)
            const scoped = (event as { properties?: { sessionID?: string } }).properties
            if (scoped?.sessionID !== sessionID) continue

            if (event.type === "session.next.step.started") {
              if (emit("step_start", { step: { agent: event.properties.agent, model: event.properties.model } })) {
                continue
              }
              if (args.format !== "json" && toggles.get("start") !== true) {
                UI.empty()
                UI.println(`> ${event.properties.agent} · ${event.properties.model.id}`)
                UI.empty()
                toggles.set("start", true)
              }
            }

            if (event.type === "session.next.step.ended") {
              const { timestamp: _t, sessionID: _s, assistantMessageID: _m, ...step } = event.properties
              if (emit("step_finish", { step })) continue
            }

            if (event.type === "session.next.tool.called") {
              calls.set(event.properties.callID, {
                tool: event.properties.tool,
                input: event.properties.input,
              })
              if (event.properties.tool === "task" && args.format !== "json") {
                if (toggles.get(event.properties.callID) === true) continue
                await tool(toolPart({ callID: event.properties.callID, state: { status: "running" } }))
                toggles.set(event.properties.callID, true)
              }
            }

            if (event.type === "session.next.tool.success") {
              const output = flatten(event.properties.content)
              if (
                emit("tool_use", {
                  tool: calls.get(event.properties.callID)?.tool ?? "unknown",
                  callID: event.properties.callID,
                  input: calls.get(event.properties.callID)?.input ?? {},
                  output,
                  structured: event.properties.structured,
                })
              ) {
                continue
              }
              await tool(
                toolPart({
                  callID: event.properties.callID,
                  state: { status: "completed", output, metadata: event.properties.structured },
                }),
              )
            }

            if (event.type === "session.next.tool.failed") {
              const message = errorMessage(event.properties.error, "tool failed")
              if (
                emit("tool_use", {
                  tool: calls.get(event.properties.callID)?.tool ?? "unknown",
                  callID: event.properties.callID,
                  input: calls.get(event.properties.callID)?.input ?? {},
                  error: event.properties.error,
                })
              ) {
                continue
              }
              await toolError(toolPart({ callID: event.properties.callID, state: { status: "error", error: message } }))
              UI.error(message)
            }

            if (event.type === "session.next.text.ended") {
              if (emit("text", { text: event.properties.text })) continue
              const text = event.properties.text.trim()
              if (!text) continue
              if (!process.stdout.isTTY) {
                process.stdout.write(text + EOL)
                continue
              }
              UI.empty()
              UI.println(text)
              UI.empty()
            }

            if (event.type === "session.next.reasoning.ended" && thinking) {
              if (emit("reasoning", { text: event.properties.text })) continue
              const text = event.properties.text.trim()
              if (!text) continue
              const line = `Thinking: ${text}`
              if (process.stdout.isTTY) {
                UI.empty()
                UI.println(`${UI.Style.TEXT_DIM}\u001b[3m${line}\u001b[0m${UI.Style.TEXT_NORMAL}`)
                UI.empty()
                continue
              }
              process.stdout.write(line + EOL)
            }

            // Turn-level failures: step.failed carries the mid-turn error; a pre-turn
            // setup failure (model resolution &c.) surfaces as a synthetic notice.
            if (event.type === "session.next.step.failed") {
              fail(errorMessage(event.properties.error, "turn failed"), event.properties.error)
            }

            if (event.type === "session.next.synthetic") {
              const text = event.properties.text.trim()
              if (text) fail(text, { message: text })
            }

            if (event.type === "session.status" && event.properties.status.type === "idle") {
              break
            }

            if (event.type === "permission.v2.asked") {
              const permission = event.properties

              if (args["dangerously-skip-permissions"]) {
                await client.v2.session.permission.reply({
                  sessionID,
                  requestID: permission.id,
                  reply: "once",
                })
              } else {
                UI.println(
                  UI.Style.TEXT_WARNING_BOLD + "!",
                  UI.Style.TEXT_NORMAL +
                    `permission requested: ${permission.action} (${permission.resources.join(", ")}); auto-rejecting`,
                )
                await client.v2.session.permission.reply({
                  sessionID,
                  requestID: permission.id,
                  reply: "reject",
                })
              }
            }
          }
          return error
        }
        const cwd = args.attach ? (directory ?? sess.directory ?? (await current(sdk))) : (directory ?? root)
        const client = args.attach ? attachSDK(cwd) : sdk

        // Validate agent if specified
        const agent = await pickAgent(client)

        const events = await client.event.subscribe()
        const completed = loop(client, events).catch((e) => {
          console.error(e)
          process.exitCode = 1
        })
        // Wait for the turn to finish: the async prompt/command endpoints return
        // before the turn runs, so completion is the `session.status idle` event
        // that `loop()` breaks on (`completed`). This holds for both local and
        // --attach runs — previously the blocking `prompt` call was itself the
        // wait, so attach could skip it; with `promptAsync` the idle event is the
        // only completion signal, so we must always await it or the process
        // exits before the (possibly remote) turn has run.
        async function finish() {
          const error = await completed
          if (error) process.exitCode = 1
        }

        if (args.command) {
          const result = await client.v2.session.command({
            sessionID,
            agent,
            model: args.model,
            command: args.command,
            arguments: message,
            variant: args.variant,
          })
          if (result.error) {
            if (!emit("error", { error: result.error })) UI.error(formatRunError(result.error))
            process.exitCode = 1
            return
          }
          await finish()
          return
        }

        const model = pick(args.model)
        // Deliver via the async endpoint (the V2/V1 router). It returns 204
        // immediately; the turn's completion is signalled by the `session.status
        // idle` event that `loop()` breaks on, and turn-level failures arrive as
        // `session.next.step.failed` / `session.next.synthetic` events.
        // `result.error` here carries only request-level (e.g. 400/404) failures.
        // The blocking `session.prompt` endpoint is legacy-only and 400s on native
        // V2 sessions, so the headless runner must use `promptAsync` to reach the
        // V2 engine.
        // V1-nuke slice D: the native prompt takes {text, files}; the per-turn agent/model persist
        // via the switch ops (the V2 semantics — the V1 promptAsync carried them inline).
        if (model) {
          const [providerID, ...restModel] = model.split("/")
          const modelID = restModel.join("/")
          if (providerID && modelID)
            await client.v2.session
              .switchModel({
                sessionID,
                model: { providerID, id: modelID, ...(args.variant ? { variant: args.variant } : {}) },
              })
              .catch(() => undefined)
        }
        if (agent) await client.v2.session.switchAgent({ sessionID, agent }).catch(() => undefined)
        const result = await client.v2.session.prompt({
          sessionID,
          prompt: {
            text: message,
            ...(files.length > 0
              ? { files: files.map((file) => ({ uri: file.url, name: file.filename })) }
              : {}),
          },
        })
        if (result.error) {
          if (!emit("error", { error: result.error })) UI.error(formatRunError(result.error))
          process.exitCode = 1
          return
        }
        await finish()
        return
      }

      if (args.attach) {
        const sdk = attachSDK(directory)
        await execute(sdk)
      } else {
        const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
          const { Server } = await import("@/server/server")
          const request = new Request(input, init)
          const headers = new Headers(request.headers)
          const auth = ServerAuth.header()
          if (auth) headers.set("Authorization", auth)
          return Server.Default().app.fetch(new Request(request, { headers }))
        }) as typeof globalThis.fetch
        const sdk = createNovaclawClient({
          baseUrl: "http://novaclaw.internal",
          fetch: fetchFn,
          directory,
        })
        await execute(sdk)
      }

      // One-shot headless command (the header's contract: "…and exits"). The in-process
      // instance keeps LIVE handles (file watchers, the event bus, the memory engine) that
      // hold bun alive after the turn settles — every CLI/smoke run leaked a ~1.5 GB orphan
      // (issues.md P2; the accumulation behind the 2026-07-20 OOM crash). Flush stdout,
      // then exit explicitly — best-effort background housekeeping dies with the process,
      // which is exactly the deal a one-shot CLI offers.
      await new Promise<void>((resolve) => process.stdout.write("", () => resolve()))
      process.exit(process.exitCode ?? 0)
    })
  }),
})
