import { isAbsolute, join, relative, sep } from "node:path"

const prefix = "novaclaw-home:/"

export class InvalidServiceDescriptor extends Error {
  constructor() { super("Service descriptor is invalid") }
}

export function storeServicePath(home: string, target: string): string {
  const tail = relative(home, target)
  return tail !== ".." && !tail.startsWith(`..${sep}`) && !isAbsolute(tail)
    ? `${prefix}${tail.replaceAll("\\", "/")}`
    : target
}

export function resolveServicePath(home: string, stored: string): string {
  if (!stored.startsWith(prefix)) return stored
  const parts = stored.slice(prefix.length).split("/")
  if (parts.some((part) => !part || part === "." || part === ".." || /[\\:\0]/.test(part))) throw new InvalidServiceDescriptor()
  return join(home, ...parts)
}
