export const EVENT_BACKLOG_LIMIT = 1024

export class EventBacklogOverflowError extends Error {
  constructor() {
    super("The event consumer fell behind and must resynchronize.")
    this.name = "EventBacklogOverflowError"
  }
}

export function enqueueEvent<T>(queue: T[], event: T) {
  if (queue.length >= EVENT_BACKLOG_LIMIT) throw new EventBacklogOverflowError()
  queue.push(event)
}
