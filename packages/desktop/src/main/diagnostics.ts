import { app } from "electron"
import { createBootTimeline, formatMark, formatSummary, type BootPhase, type ProcessMemory } from "./boot-timeline"
import { initCrashReporter, initLogging, write as writeLog } from "./logging"

export function createDesktopDiagnostics() {
  const logger = initLogging()
  initCrashReporter()
  // Runtime home resolution is module-scoped in the kernel. Import only after InstanceHome has
  // selected the home; an eager import here would capture the default home before --home applies.
  const capture = import("@novaclaw/core/observability/crash-capture")
    .then(({ CrashCapture }) => {
      const sources = CrashCapture.liveSources("ui")
      CrashCapture.install({ plane: "ui", sources })
      return (kind: string) => CrashCapture.capture(new Error(kind), "uncaughtException", sources)
    })
    .catch((error) => {
      logger.warn("crash capture could not initialize", error)
      return undefined
    })
  const captureFailure = (kind: string) => {
    void capture.then((report) => report?.(kind))
  }
  const readMemory = (): readonly ProcessMemory[] => {
    try {
      return app.getAppMetrics().map((entry) => ({
        kind: entry.name ? `${entry.type}:${entry.name}` : entry.type,
        pid: entry.pid,
        workingSetBytes: (entry.memory?.workingSetSize ?? 0) * 1024,
      }))
    } catch {
      return []
    }
  }
  const timeline = createBootTimeline({
    now: () => Date.now(),
    processStartedAt: process.getCreationTime?.() ?? Date.now(),
    memory: readMemory,
  })
  const mark = (phase: BootPhase) => {
    const value = timeline.mark(phase)
    if (!value) return
    logger.log(formatMark(value))
    if (phase === "first-chat-token") logger.log(formatSummary(timeline.summary()))
  }
  app.on("will-quit", () => {
    const summary = timeline.summary()
    if (summary.missing.length) logger.log(formatSummary(summary))
  })
  app.on("child-process-gone", (_event, details) => {
    writeLog("utility", "child process gone", { details }, "error")
    captureFailure("child-process-gone")
  })
  app.on("render-process-gone", (_event, contents, details) => {
    writeLog("window", "app render process gone", { url: contents.getURL(), details }, "error")
    captureFailure("render-process-gone")
  })
  return { logger, mark, captureFailure }
}
