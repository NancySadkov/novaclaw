export * as MessengerWire from "./wire"

// The line-oriented-protocol primitives every driver that speaks one goes through.
//
// 🔴 **The class this file exists to end: a serializer that does not own its own framing.** IRC, SMTP
// and every other line protocol end a record at a CR or an LF, so a value we did not author — a
// remote sender's decoded Subject, a model-supplied chat id, a nickname typed into Settings — that
// still carries one does not become malformed, it becomes a SECOND record, attributed to us. The
// caller cannot own that check, because the caller is exactly who forgets: the wrong call
// (interpolate the value straight into the template) is the shorter one, and it works on every
// input anyone tests with. So the serializer strips, and a seam that must not guess REFUSES.
//
// The precedent for the shape is `SessionWorkerProtocol.encodeLine` — a protocol whose framing is
// produced by one function nobody writes around.

// ⚠️ NUL is BUILT from its code point, never written as an escape: a literal NUL byte in a source
// file is invisible in every editor and every diff. It belongs with CR and LF because RFC 2812
// forbids it outright and a C-implemented MTA truncates a header at it.
const NUL = String.fromCharCode(0)
const BREAK_TEST = new RegExp(`[\r\n${NUL}]`)
const BREAK_ALL = new RegExp(`[\r\n${NUL}]+`, "g")

/** Does this value carry something that would end the line it is written into? */
export const breaksLine = (value: string): boolean => BREAK_TEST.test(value)

/** Flatten a value so it cannot end the line it is written into. The replacement is a space, not
 *  `""`: deleting a break silently JOINS two words into one token that reads as deliberate, while a
 *  space reads as the line break it stands in for. */
export const flatten = (value: string, replacement = " "): string => value.replace(BREAK_ALL, replacement)

/** Split text on ANY line ending — CRLF, a lone CR, a lone LF. Splitting on `"\n"` alone is the bug
 *  this replaces: the wire terminator is CRLF, so a lone CR survives that split and still ends the
 *  record on the far side. */
export const lines = (text: string): string[] => text.split(/\r\n|\r|\n/)

/** A value quoted for an error message a human (or a chat) will read — the raw value would carry
 *  its own line break into the log line that reports it. */
export const quote = (value: string): string => JSON.stringify(value)
