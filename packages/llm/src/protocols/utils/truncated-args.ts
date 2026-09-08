// 1O / codehamr A4 — the dominant small-model write failure: a large tool call's streamed arguments
// are truncated at the model server's output-token limit, so the accumulated JSON never closes
// ("unexpected end of JSON input"). Failing the whole turn HALTS the loop; dropping the call makes
// the model retry the same whole-file write forever ("these runs waste their budget *and* ship the
// bug"). Instead the decoder emits the call with THIS sentinel as its input, and the tool settle path
// detects it and returns a prescriptive result telling the model to build the file in chunks — so it
// self-corrects in one step. The sentinel result also classifies as a tool failure, feeding 1N/A2's
// target-keyed streak.

export const TRUNCATED_ARGS_SENTINEL = "__novaclaw_truncated_tool_args__"

/** The input object a decoder emits in place of the unparseable args; carries the parse error text. */
export const truncatedArgsInput = (parseError: string): Record<string, string> => ({
  [TRUNCATED_ARGS_SENTINEL]: parseError,
})

/** The parse-error text if `input` is a truncated-args sentinel, else undefined. Total and safe. */
export const truncatedArgsMessage = (input: unknown): string | undefined => {
  if (input === null || typeof input !== "object") return undefined
  const value = (input as Record<string, unknown>)[TRUNCATED_ARGS_SENTINEL]
  return typeof value === "string" ? value : undefined
}

/**
 * The prescriptive tool result for a truncated-args call (codehamr's exact recovery, adapted to our
 * write/edit tools). Named the real cause + the exact fix so a small model corrects in one step.
 */
export const truncatedArgsResult = (name: string, parseError: string): string =>
  `The arguments for this \`${name}\` call were not valid JSON (${parseError}). This almost always means ` +
  `the content was too large and the model server truncated the call at its output-token limit. Do NOT ` +
  `retry the same whole-file write — you will hit the same wall. Instead build the file in chunks with ` +
  `bash heredoc appends: \`cat > path <<'EOF'\` … \`EOF\` for the first part, then \`cat >> path <<'EOF'\` ` +
  `… \`EOF\` for each following part, then verify with \`wc -c path\`.`

export * as TruncatedArgs from "./truncated-args"
