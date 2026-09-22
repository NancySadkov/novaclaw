import { isSessionNotFoundError, isUnreachableError } from "./server-errors"

export function shouldSuppressSessionExecutionError(error: unknown, sessionID: string) {
  return isUnreachableError(error) || isSessionNotFoundError(error, sessionID)
}
