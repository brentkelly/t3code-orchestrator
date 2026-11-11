/**
 * Did the agent's last message end blocked on a human answer? Agents ask in prose despite
 * the envelope, so the board reads the text. Deliberately generous: both outcomes mean a
 * human is needed, and a false positive only costs violet instead of amber.
 */

/** Long enough to reach past several paragraph-sized options to the question that
 *  introduced them; short enough that a pasted plan is not swept for an early `?`. */
const TAIL_WINDOW = 4000;

/** Ask-shapes that routinely arrive WITHOUT a question mark. Kept short on
    purpose: every entry is a phrase whose only ordinary reading is "over to
    you", so the list can grow only when a real message defeats it. */
const ASK_PHRASES = [
  "let me know",
  "your call",
  "please confirm",
  "waiting for your",
  "awaiting your",
  "tell me which",
  "which would you prefer",
] as const;

/** Inline code spans, including the double-backtick form that can contain a
    single backtick. */
const INLINE_CODE = /`{1,2}[^`\n]*`{1,2}/g;
/** A fence opener or closer: three or more backticks or tildes on their own
    line (an info string after the opener is allowed). */
const FENCE = /^[ \t]*(`{3,}|~{3,})/;

/**
 * Line-wise, not regex: under the multiline flag `$` matches every line end, so a lazy
 * body stops at the first newline. An unterminated fence swallows the rest, which is code
 * the agent was still writing.
 */
function stripFencedBlocks(text: string): string {
  const kept: Array<string> = [];
  let fence: string | null = null;
  for (const line of text.split("\n")) {
    const marker = FENCE.exec(line)?.[1];
    if (fence === null) {
      if (marker === undefined) kept.push(line);
      else fence = marker[0]!; // the fence CHARACTER; a closer may be longer
      continue;
    }
    // Only a fence of the same character closes the block.
    if (marker !== undefined && marker[0] === fence) fence = null;
  }
  return kept.join("\n");
}
/** Trailing markdown emphasis / list punctuation, so `**Which one?**` and
    `Which one?*` both end in a question mark once trimmed. */
const TRAILING_MARKUP = /[*_~\s>]+$/;
/** A markdown heading, captured so its TEXT can be tested for "question". */
const HEADING = /^[ \t]*#{1,6}[ \t]+(.+)$/gm;

/**
 * Whether an assistant's final message reads as blocked on a human answer.
 *
 * Pure and total: no I/O, no provider knowledge, no clock. The reactor resolves
 * the text and passes it in, exactly as it resolves `progressedSinceLastNudge`
 * for `recoveryDecision`.
 */
export function boardTextEndsWithQuestion(text: string): boolean {
  const prose = stripFencedBlocks(text).replace(INLINE_CODE, " ");
  const window = prose.length > TAIL_WINDOW ? prose.slice(-TAIL_WINDOW) : prose;
  if (window.trim().length === 0) return false;

  // A question mark ending any line in the window. Line-wise rather than
  // message-wise so "Which of these? " followed by three long option blocks
  // still reads as a question — the case a "last sentence" test misses and the
  // case this whole spec is about.
  for (const line of window.split("\n")) {
    if (line.replace(TRAILING_MARKUP, "").endsWith("?")) return true;
  }

  const lowered = window.toLowerCase();
  if (ASK_PHRASES.some((phrase) => lowered.includes(phrase))) return true;

  // A heading the agent wrote to introduce what it needs decided — "## Open
  // questions" — which is how a long message asks without a sentence-final `?`.
  for (const match of window.matchAll(HEADING)) {
    if (match[1] !== undefined && match[1].toLowerCase().includes("question")) return true;
  }
  return false;
}
