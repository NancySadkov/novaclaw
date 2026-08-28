import { type ParseError as ParserError, parse as parseWithComments, printParseErrorCode } from "jsonc-parser"

export type JSONCParseIssue = Readonly<{
  code: string
  offset: number
  length: number
  line: number
  column: number
}>

/**
 * A syntax failure from `parseJSONC`. `jsonc-parser` can return a partial value alongside its error
 * list, so callers must receive an exception instead of accidentally importing that partial object.
 */
export class JSONCParseError extends SyntaxError {
  constructor(public readonly issues: readonly JSONCParseIssue[]) {
    super(issues.map((issue) => `${issue.code} at line ${issue.line}, column ${issue.column}`).join("\n"))
    this.name = "JSONCParseError"
  }
}

function locate(content: string, error: ParserError): JSONCParseIssue {
  const before = content.slice(0, error.offset).split(/\r\n|\r|\n/)
  return {
    code: printParseErrorCode(error.error),
    offset: error.offset,
    length: error.length,
    line: before.length,
    column: (before.at(-1)?.length ?? 0) + 1,
  }
}

/** Parse JSON or JSONC without treating comment-shaped bytes inside strings as comments. */
export function parseJSONC(content: string): unknown {
  const errors: ParserError[] = []
  const value = parseWithComments(content, errors, {
    allowTrailingComma: true,
    disallowComments: false,
    allowEmptyContent: false,
  })
  if (errors.length > 0) throw new JSONCParseError(errors.map((error) => locate(content, error)))
  return value
}

export function isJSONObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
