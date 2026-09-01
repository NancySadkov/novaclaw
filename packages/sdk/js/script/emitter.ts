import path from "node:path"

type Schema = {
  $ref?: string
  type?: string
  enum?: unknown[]
  anyOf?: Schema[]
  oneOf?: Schema[]
  properties?: Record<string, Schema>
  required?: string[]
  items?: Schema
  additionalProperties?: boolean | Schema
  description?: string
  format?: string
}

type Parameter = {
  name: string
  in: "path" | "query" | "header" | "cookie"
  required?: boolean
  description?: string
  schema?: Schema
}

type Response = {
  description?: string
  content?: Record<string, { schema?: Schema }>
}

type Operation = {
  operationId: string
  summary?: string
  description?: string
  parameters?: Parameter[]
  requestBody?: {
    required?: boolean
    content?: Record<string, { schema?: Schema }>
  }
  responses: Record<string, Response>
}

type Document = {
  paths: Record<string, Record<string, Operation | unknown>>
  components: { schemas: Record<string, Schema> }
}

const METHODS = new Set(["get", "post", "put", "delete", "patch"])
const refPrefix = "#/components/schemas/"

function words(value: string): string[] {
  return (
    value
      .replace(/[^A-Za-z0-9]+/g, " ")
      .replace(/([A-Za-z])([0-9])/g, "$1 $2")
      .replace(/([0-9])([A-Za-z])/g, "$1 $2")
      .match(/[A-Z]+(?=[A-Z][a-z]|\b)|[A-Z]?[a-z]+|[0-9]+/g) ?? []
  )
}

function pascal(value: string): string {
  return words(value)
    .map((word) => word[0]!.toUpperCase() + word.slice(1).toLowerCase())
    .join("")
}

function camel(value: string): string {
  const result = pascal(value)
  return result[0]!.toLowerCase() + result.slice(1)
}

function property(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name)
}

export function schemaTypeNames(document: Pick<Document, "components">): Map<string, string> {
  const result = new Map<string, string>()
  const used = new Map<string, number>()
  for (const name of Object.keys(document.components.schemas)) {
    const base = name === "ToolIDs" ? "ToolIds" : pascal(name)
    const count = (used.get(base) ?? 0) + 1
    used.set(base, count)
    result.set(name, count === 1 ? base : `${base}${count}`)
  }
  return result
}

function doc(text: string | undefined, indent = ""): string {
  if (!text) return ""
  const safe = text.replaceAll("*/", "* /")
  return `${indent}/**\n${safe
    .split("\n")
    .map((line) => `${indent} * ${line}`)
    .join("\n")}\n${indent} */\n`
}

export async function emit(document: Document, output: string): Promise<void> {
  const schemaNames = schemaTypeNames(document)

  const typeName = (name: string): string => schemaNames.get(name) ?? pascal(name)
  const render = (schema: Schema | undefined, level = 0, qualified = false): string => {
    if (!schema) return "unknown"
    if (schema.$ref?.startsWith(refPrefix))
      return `${qualified ? "T." : ""}${typeName(schema.$ref.slice(refPrefix.length))}`
    const union = schema.anyOf ?? schema.oneOf
    if (union) return union.map((item) => render(item, level, qualified)).join(" | ")
    if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(" | ") || "never"
    if (schema.type === "null") return "null"
    if (schema.type === "boolean") return "boolean"
    if (schema.type === "integer" || schema.type === "number") return "number"
    if (schema.type === "string") return schema.format === "binary" ? "Blob | File" : "string"
    if (schema.type === "array") return `Array<${render(schema.items, level, qualified)}>`
    if (schema.type === "object" || schema.properties || schema.additionalProperties !== undefined) {
      const indent = "  ".repeat(level)
      const child = "  ".repeat(level + 1)
      const required = new Set(schema.required ?? [])
      const fields = Object.entries(schema.properties ?? {}).map(
        ([name, value]) =>
          `${doc(value.description, child)}${child}${property(name)}${required.has(name) ? "" : "?"}: ${render(value, level + 1, qualified)}`,
      )
      if (schema.additionalProperties && typeof schema.additionalProperties === "object")
        fields.push(`${child}[key: string]: ${render(schema.additionalProperties, level + 1, qualified)}`)
      else if (schema.additionalProperties !== false && fields.length === 0)
        fields.push(`${child}[key: string]: unknown`)
      return fields.length ? `{\n${fields.join("\n")}\n${indent}}` : "Record<string, never>"
    }
    return "unknown"
  }

  const operations: Array<{ route: string; method: string; operation: Operation; prefix: string }> = []
  for (const [route, item] of Object.entries(document.paths))
    for (const [method, value] of Object.entries(item))
      if (METHODS.has(method)) {
        const operation = value as Operation
        operations.push({ route, method, operation, prefix: pascal(operation.operationId) })
      }

  const jsonSchema = (content: Record<string, { schema?: Schema }> | undefined): Schema | undefined =>
    content?.["application/json"]?.schema ??
    content?.["text/event-stream"]?.schema ??
    Object.values(content ?? {})[0]?.schema

  const requestContentType = (content: Record<string, { schema?: Schema }> | undefined): string | undefined => {
    if (!content) return undefined
    if (content["application/json"]) return "application/json"
    return Object.keys(content)[0]
  }

  const responseType = (response: Response): string => {
    const schema = jsonSchema(response.content)
    return schema ? render(schema) : "void"
  }

  /**
   * ⚠️ **The spec is the answer; this does not carry a second one.** Until 2026-09-01 (RF-24-4) this
   * hard-coded `v2.session.history`'s `limit`/`after` as numbers — a one-route special case, which is
   * exactly why the generated SDK's types CONTRADICTED our own published `openapi.json` on that
   * route: the spec said `string`, the SDK said `number`. The numeric-ness now travels in the spec
   * (see `QueryParameterSchemas` in the instance server's `public.ts`, which explains why it cannot
   * be derived), so passing the parameter through is both simpler and the only way the two artifacts
   * can agree by construction.
   */
  const parameterSchema = (_operationID: string, item: Parameter): Schema => item.schema ?? {}

  const types: string[] = [
    "// This file is generated by NovaClaw's owned OpenAPI emitter.\n",
    "export type ClientOptions = {\n  baseUrl: `${string}://${string}` | (string & {})\n}\n",
  ]
  for (const [name, schema] of Object.entries(document.components.schemas))
    types.push(`${doc(schema.description)}export type ${typeName(name)} = ${render(schema)}\n`)

  for (const { route, operation, prefix } of operations) {
    const parameters = operation.parameters ?? []
    const body = jsonSchema(operation.requestBody?.content)
    const byLocation = (location: Parameter["in"]): Parameter[] => parameters.filter((item) => item.in === location)
    const group = (location: Parameter["in"]): string => {
      const entries = byLocation(location)
      if (!entries.length) return "never"
      const required = entries.some((entry) => entry.required)
      const fields = entries.map(
        (entry) =>
          `${doc(entry.description, "    ")}    ${property(entry.name)}${entry.required ? "" : "?"}: ${render(parameterSchema(operation.operationId, entry), 2)}`,
      )
      return `${required ? "" : ""}{\n${fields.join("\n")}\n  }`
    }
    const data = [
      "{",
      `  body${operation.requestBody?.required ? "" : "?"}: ${body ? render(body, 1) : "never"}`,
      `  path${byLocation("path").some((item) => item.required) ? "" : "?"}: ${group("path")}`,
      `  query${byLocation("query").some((item) => item.required) ? "" : "?"}: ${group("query")}`,
      `  url: ${JSON.stringify(route)}`,
      "}",
    ].join("\n")
    types.push(`export type ${prefix}Data = ${data}\n`)

    const responses = Object.entries(operation.responses)
    const errors = responses.filter(([status]) => Number(status) >= 400)
    const success = responses.filter(([status]) => Number(status) < 400)
    if (errors.length) {
      types.push(
        `export type ${prefix}Errors = {\n${errors
          .map(([status, response]) => `${doc(response.description, "  ")}  ${status}: ${responseType(response)}`)
          .join("\n")}\n}\n`,
      )
      const errorName = schemaNames.has(`${prefix}Error`) ? `${prefix}Error2` : `${prefix}Error`
      types.push(`export type ${errorName} = ${prefix}Errors[keyof ${prefix}Errors]\n`)
    }
    types.push(
      `export type ${prefix}Responses = {\n${success
        .map(([status, response]) => `${doc(response.description, "  ")}  ${status}: ${responseType(response)}`)
        .join("\n")}\n}\n`,
    )
    types.push(`export type ${prefix}Response = ${prefix}Responses[keyof ${prefix}Responses]\n`)
  }

  type Node = { children: Map<string, Node>; operations: typeof operations }
  const root: Node = { children: new Map(), operations: [] }
  for (const item of operations) {
    const parts = item.operation.operationId.split(".")
    const methodName = parts.pop()!
    let node = root
    for (const part of parts) {
      let child = node.children.get(part)
      if (!child) node.children.set(part, (child = { children: new Map(), operations: [] }))
      node = child
    }
    node.operations.push({ ...item, operation: { ...item.operation, sdkMethod: methodName } as Operation })
  }

  const nodeNames = new Map<Node, string>()
  const assignNames = (node: Node, trail: string[]) => {
    if (node !== root) nodeNames.set(node, `Api${trail.map(pascal).join("")}`)
    for (const [part, child] of node.children) assignNames(child, [...trail, part])
  }
  assignNames(root, [])

  const flatParameters = (
    operation: Operation,
  ): Array<{ name: string; wire: string; required: boolean; schema: Schema; in: string }> => {
    const result = (operation.parameters ?? []).map((item) => ({
      name: item.name,
      wire: item.name,
      required: !!item.required,
      schema: parameterSchema(operation.operationId, item),
      in: item.in as string,
    }))
    const body = jsonSchema(operation.requestBody?.content)
    if (body?.properties && Object.keys(body.properties).length > 0) {
      const required = new Set(body.required ?? [])
      for (const [name, schema] of Object.entries(body.properties ?? {}))
        result.push({
          name,
          wire: name,
          required: required.has(name) && !!operation.requestBody?.required,
          schema,
          in: "body",
        })
    } else if (body) {
      const ref = body.$ref?.startsWith(refPrefix) ? typeName(body.$ref.slice(refPrefix.length)) : undefined
      const name = ref ? camel(ref) : "body"
      result.push({ name, wire: name, required: !!operation.requestBody?.required, schema: body, in: "body-ref" })
    }
    const counts = new Map<string, number>()
    for (const item of result) counts.set(item.name, (counts.get(item.name) ?? 0) + 1)
    for (const item of result)
      if ((counts.get(item.name) ?? 0) > 1) item.name = `${item.in === "body-ref" ? "body" : item.in}_${item.name}`
    return result
  }

  const emitNode = (node: Node): string => {
    const name = nodeNames.get(node)!
    const lines = [`class ${name} extends NovaClawApiClient {`]
    for (const item of node.operations) {
      const op = item.operation
      const methodName = (op as Operation & { sdkMethod: string }).sdkMethod
      const fields = flatParameters(op)
      const required = fields.some((field) => field.required)
      const parameterType = fields.length
        ? `{\n${fields
            .map(
              (field) => `      ${property(field.name)}${field.required ? "" : "?"}: ${render(field.schema, 3, true)}`,
            )
            .join("\n")}\n    }`
        : undefined
      lines.push(doc([op.summary, op.description].filter(Boolean).join("\n\n"), "  ").trimEnd())
      lines.push(`  public ${property(methodName)}<ThrowOnError extends boolean = false>(`)
      if (parameterType) lines.push(`    parameters${required ? "" : "?"}: ${parameterType},`)
      lines.push(`    options?: Options<never, ThrowOnError>,`)
      lines.push("  ) {")
      if (fields.length) {
        const slots = (location: string) => fields.filter((field) => field.in === location)
        for (const location of ["path", "query"])
          if (slots(location).length)
            lines.push(
              `    const ${location} = { ${slots(location)
                .map((field) => `${JSON.stringify(field.wire)}: parameters?.[${JSON.stringify(field.name)}]`)
                .join(", ")} }`,
            )
        const bodyFields = slots("body")
        const bodyRef = slots("body-ref")[0]
        if (bodyFields.length)
          lines.push(
            `    const body = { ${bodyFields
              .map((field) => `${JSON.stringify(field.wire)}: parameters?.[${JSON.stringify(field.name)}]`)
              .join(", ")} }`,
          )
        else if (bodyRef) lines.push(`    const body = parameters?.[${JSON.stringify(bodyRef.name)}]`)
      }
      const isSse = Object.values(op.responses).some((response) => "text/event-stream" in (response.content ?? {}))
      const errors = Object.keys(op.responses).some((status) => Number(status) >= 400)
        ? `T.${item.prefix}Errors`
        : "unknown"
      lines.push(
        `    return (options?.client ?? this.client).${isSse ? "sse." : ""}${item.method}<T.${item.prefix}Responses, ${errors}, ThrowOnError>({`,
      )
      lines.push(`      url: ${JSON.stringify(item.route)},`)
      lines.push("      ...options,")
      for (const location of ["path", "query"])
        if (fields.some((field) => field.in === location)) lines.push(`      ${location},`)
      if (fields.some((field) => field.in.startsWith("body"))) lines.push("      body,")
      if (fields.some((field) => field.in.startsWith("body"))) {
        const contentType = requestContentType(op.requestBody?.content) ?? "application/json"
        // The generated client defaults to JSON serialization. Binary request bodies must bypass
        // that serializer or a perfectly typed Blob/File reaches the wire as `{}`.
        if (contentType !== "application/json") lines.push("      bodySerializer: null,")
        lines.push(`      headers: { "Content-Type": ${JSON.stringify(contentType)}, ...options?.headers },`)
      }
      lines.push("    })", "  }", "")
    }
    const operationNames = new Set(
      node.operations.map((item) => (item.operation as Operation & { sdkMethod: string }).sdkMethod),
    )
    for (const [part, child] of node.children) {
      const childName = nodeNames.get(child)!
      const getter = operationNames.has(part) ? `${part}2` : part
      lines.push(`  private _${camel(part)}?: ${childName}`)
      lines.push(`  get ${property(getter)}(): ${childName} {`)
      lines.push(`    return (this._${camel(part)} ??= new ${childName}({ client: this.client }))`)
      lines.push("  }", "")
    }
    lines.push("}", "")
    return lines.join("\n")
  }

  const allNodes: Node[] = []
  const collect = (node: Node) => {
    for (const child of node.children.values()) {
      collect(child)
      allNodes.push(child)
    }
  }
  collect(root)
  const sdk = [
    "// This file is generated by NovaClaw's owned OpenAPI emitter.",
    'import { client } from "./client.gen.js"',
    'import type * as T from "./types.gen.js"',
    'import { type Client, type Options as Options2, type TDataShape } from "./client/index.js"',
    "",
    "export type Options<TData extends TDataShape = TDataShape, ThrowOnError extends boolean = boolean> = Options2<TData, ThrowOnError> & { client?: Client; meta?: Record<string, unknown> }",
    "class NovaClawApiClient { protected client: Client; constructor(args?: { client?: Client }) { this.client = args?.client ?? client } }",
    ...allNodes.map(emitNode),
    "export class NovaclawClient extends NovaClawApiClient {",
    ...[...root.children].flatMap(([part, child]) => {
      const childName = nodeNames.get(child)!
      return [
        `  private _${camel(part)}?: ${childName}`,
        `  get ${property(part)}(): ${childName} { return (this._${camel(part)} ??= new ${childName}({ client: this.client })) }`,
      ]
    }),
    "}",
    "",
  ].join("\n")

  await Promise.all([
    Bun.write(path.join(output, "types.gen.ts"), types.join("\n")),
    Bun.write(path.join(output, "sdk.gen.ts"), sdk),
  ])
}
