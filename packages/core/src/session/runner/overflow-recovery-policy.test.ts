import { describe, expect, test } from "bun:test"
import {
  DROP_FRACTION,
  authorizeRetry,
  plan,
  sameCalibrationRoute,
  type CalibrationRoute,
} from "./overflow-recovery-policy"

const route = (over: Partial<CalibrationRoute> = {}): CalibrationRoute => ({
  providerID: "local",
  wireModelID: "small-model",
  serverKey: "http://127.0.0.1:8000/v1",
  routeID: "openai-chat",
  protocolID: "openai-chat",
  ...over,
})

describe("OverflowRecoveryPolicy", () => {
  test("plans one fixed 25 percent cut from the failed prompt", () => {
    expect(
      plan({
        failure: { classification: "context-overflow", message: "maximum context length exceeded", status: 400 },
        originalPromptTokens: 1_001,
        recoveryAttempts: 0,
      }),
    ).toEqual({
      action: "compress",
      originalPromptTokens: 1_001,
      targetPromptTokens: 750,
      dropFraction: DROP_FRACTION,
    })
  })

  test("never retries unchanged, grown, or insufficiently compressed prompts", () => {
    const recovery = plan({
      failure: { classification: "context-overflow", message: "prompt too long" },
      originalPromptTokens: 1_000,
      recoveryAttempts: 0,
    })
    const failedRoute = route()

    for (const compressedPromptTokens of [1_000, 1_100])
      expect(authorizeRetry({ plan: recovery, compressedPromptTokens, failedRoute, retryRoute: failedRoute })).toEqual({
        action: "stop",
        reason: "not-smaller",
      })
    expect(
      authorizeRetry({ plan: recovery, compressedPromptTokens: 751, failedRoute, retryRoute: failedRoute }),
    ).toEqual({
      action: "stop",
      reason: "insufficient-reduction",
    })
    expect(
      authorizeRetry({ plan: recovery, compressedPromptTokens: 750, failedRoute, retryRoute: failedRoute }),
    ).toEqual({
      action: "retry",
      originalPromptTokens: 1_000,
      compressedPromptTokens: 750,
      calibration: "retain",
    })
  })

  test("permits no second cut or binary-search retry", () => {
    expect(
      plan({
        failure: { classification: "context-overflow", message: "prompt too long" },
        originalPromptTokens: 1_000,
        recoveryAttempts: 1,
      }),
    ).toEqual({ action: "stop", reason: "already-recovered" })
  })

  test("rejects OOM 400s even when an upstream classifier called them context overflow", () => {
    for (const message of [
      "400: CUDA out of memory",
      "400 Bad Request: OOM while allocating KV cache",
      "failed to allocate 67108864 bytes",
      "insufficient GPU memory",
    ])
      expect(
        plan({
          failure: { classification: "context-overflow", message, status: 400 },
          originalPromptTokens: 10_000,
          recoveryAttempts: 0,
        }),
      ).toEqual({ action: "stop", reason: "resource-exhausted" })

    expect(
      plan({
        failure: { classification: "invalid-request", message: "400 Bad Request" },
        originalPromptTokens: 10_000,
        recoveryAttempts: 0,
      }),
    ).toEqual({ action: "stop", reason: "not-context-overflow" })
  })

  test("invalidates calibration on actual model or server route switches", () => {
    const failedRoute = route()
    const recovery = plan({
      failure: { classification: "context-overflow", message: "prompt too long" },
      originalPromptTokens: 1_000,
      recoveryAttempts: 0,
    })
    const authorization = (retryRoute: CalibrationRoute) =>
      authorizeRetry({ plan: recovery, compressedPromptTokens: 700, failedRoute, retryRoute })

    expect(sameCalibrationRoute(failedRoute, route({ serverKey: `${failedRoute.serverKey}/` }))).toBe(true)
    expect(authorization(route({ serverKey: `${failedRoute.serverKey}/` }))).toMatchObject({ calibration: "retain" })
    expect(authorization(route({ wireModelID: "other-model" }))).toMatchObject({ calibration: "invalidate" })
    expect(authorization(route({ serverKey: "http://127.0.0.1:9000/v1" }))).toMatchObject({
      calibration: "invalidate",
    })
  })
})
