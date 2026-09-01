import { describe, expect } from "bun:test"
import { LLMError } from "@novaclaw/llm"
import { Cause, Deferred, Duration, Effect, Exit, Fiber, Option, Semaphore, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { it } from "../../../test/lib/effect"
import { runForEach, withStallTimeout } from "./provider-stream-liveness"

describe("provider stream liveness", () => {
  it.effect("fails a connection that produces no events instead of waiting forever", () =>
    Effect.gen(function* () {
      const fiber = yield* withStallTimeout(Stream.never, 5_000).pipe(Stream.runDrain, Effect.forkScoped)
      yield* TestClock.adjust(Duration.seconds(5))
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) return
      const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause))
      expect(error).toBeInstanceOf(LLMError)
      expect((error as LLMError).reason).toMatchObject({ _tag: "Transport", kind: "Timeout" })
      expect((error as LLMError).reason.message).toContain("would not hang indefinitely")
    }),
  )

  it.effect("passes through a healthy stream unchanged", () =>
    Effect.gen(function* () {
      const values = yield* withStallTimeout(Stream.fromIterable([1, 2, 3]), 5_000).pipe(Stream.runCollect)
      expect(Array.from(values)).toEqual([1, 2, 3])
    }),
  )

  it.effect("classifies a stall after partial output as an incomplete reply so the runner can continue", () =>
    Effect.gen(function* () {
      let hasOutput = false
      const source = Stream.make("partial").pipe(
        Stream.tap(() => Effect.sync(() => (hasOutput = true))),
        Stream.concat(Stream.never),
      )
      const fiber = yield* withStallTimeout(source, 5_000, () => hasOutput).pipe(Stream.runDrain, Effect.forkScoped)
      yield* Effect.yieldNow
      yield* TestClock.adjust(Duration.seconds(5))
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) return
      const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause))
      expect(error).toBeInstanceOf(LLMError)
      expect((error as LLMError).reason).toMatchObject({ _tag: "InvalidProviderOutput" })
      expect((error as LLMError).reason.message).toContain("continue safely")
    }),
  )

  it.effect("also bounds a consumer that stalls after durably committing a partial tool-input event", () =>
    Effect.gen(function* () {
      let durable = false
      const committed = yield* Deferred.make<void>()
      const withPublication = Semaphore.makeUnsafe(1).withPermit
      const fiber = yield* Effect.uninterruptibleMask((restore) =>
        restore(
          runForEach(Stream.make("tool-input-start"), 5_000, () => durable, () =>
            withPublication(
              Effect.sync(() => (durable = true)).pipe(
                Effect.andThen(Deferred.succeed(committed, undefined)),
                Effect.andThen(Effect.never),
              ),
            ),
          ),
        ),
      ).pipe(Effect.forkScoped)
      yield* Deferred.await(committed)
      expect(durable).toBe(true)
      yield* TestClock.adjust(Duration.seconds(5))
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) return
      const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause))
      expect(error).toBeInstanceOf(LLMError)
      expect((error as LLMError).reason).toMatchObject({ _tag: "InvalidProviderOutput" })
      expect((error as LLMError).reason.message).toContain("continue safely")
    }),
  )

  it.effect("passes a healthy consumer exactly once per event", () =>
    Effect.gen(function* () {
      const consumed: number[] = []
      yield* runForEach(Stream.fromIterable([1, 2, 3]), 5_000, () => false, (value) =>
        Effect.sync(() => {
          consumed.push(value)
        }),
      )
      expect(consumed).toEqual([1, 2, 3])
    }),
  )
})
