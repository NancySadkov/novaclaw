import { AgentV2 } from "../agent"

export * as ColleagueMessageRate from "./colleague-message-rate"

export interface Message {
  readonly sender: string
  readonly recipient: string
  readonly at: number
}

export const DEFAULT_MINUTES = 60

export const isDirectSuperior = (roster: ReadonlyArray<AgentV2.Info>, sender: string, recipient: string): boolean => {
  const target = roster.find((agent) => String(agent.id) === recipient)
  if (!target) return false
  const parent = AgentV2.resolveSuperior(recipient, target.superior, roster, { includePaused: true })
  return parent !== undefined && String(parent.id) === sender
}

export const refusal = (input: {
  readonly sender: string
  readonly recipients: ReadonlyArray<string>
  readonly roster: ReadonlyArray<AgentV2.Info>
  readonly intervals: Readonly<Record<string, number>>
  readonly messages: ReadonlyArray<Message>
  readonly now: number
}): string | undefined => {
  const staged = [...input.messages]
  let outgoingSpent = false
  for (const recipient of input.recipients) {
    if (isDirectSuperior(input.roster, input.sender, recipient)) continue
    for (const [officer, direction] of [
      [input.sender, "out"],
      [recipient, "in"],
    ] as const) {
      if (direction === "out" && outgoingSpent) continue
      if (
        direction === "in" &&
        !input.roster.some((agent) => String(agent.id) === recipient && AgentV2.kindOf(agent) === "agent")
      )
        continue
      const minutes = input.intervals[officer] ?? DEFAULT_MINUTES
      const active = staged.some(
        (message) =>
          input.now - message.at < minutes * 60_000 &&
          !isDirectSuperior(input.roster, message.sender, message.recipient) &&
          (direction === "out" ? message.sender === officer : message.recipient === officer),
      )
      if (active) return `Rate-limit 1 message per ${minutes} minutes - respect everyone's time.`
    }
    staged.push({ sender: input.sender, recipient, at: input.now })
    outgoingSpent = true
  }
  return undefined
}
