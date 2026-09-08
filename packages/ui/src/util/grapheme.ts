// The first USER-PERCEIVED character of a string, for the avatar initial.
//
// ⚠️ Not `value[0]`, and not `Array.from(value)[0]` either. A code unit splits an emoji in half; a code
// POINT still splits a flag, a skin-toned emoji, a ZWJ family or a Devanagari cluster — each of which is
// several code points that render as one glyph. A colleague whose name starts with one of those would
// get a broken mojibake initial in the roster, which is the mirror test failing on the face the user
// picked. `Intl.Segmenter` is the only thing that answers this correctly, with the code-point walk kept
// as the fallback for a runtime that lacks it.

const segmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : undefined

export function firstGrapheme(value: string): string {
  if (!value) return ""
  if (!segmenter) return Array.from(value)[0] ?? ""
  return segmenter.segment(value)[Symbol.iterator]().next().value?.segment ?? Array.from(value)[0] ?? ""
}
