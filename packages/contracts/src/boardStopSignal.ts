/**
 * T3o stop-signal reading (t3o-34) — did the agent's last message end blocked
 * on a human answer?
 *
 * A human-in-the-loop step whose turn ends without completing has stopped and
 * will not move again on its own. That much is structural. This module answers
 * the only remaining question: is there something for the human to *answer*, or
 * just something to look at? The board paints the first violet ("Input needed")
 * and the second amber ("Needs a human").
 *
 * The envelope already asks agents to raise blockers through their runtime's
 * user-input request (`BOARD_ENVELOPE_QUESTION_MECHANISM`) and forbids ending a
 * turn with a question in prose. They do it anyway — a question with a
 * paragraph of consequence per option is a poor fit for a structured picker, and
 * planning is the stage where asking IS the job. So the board reads the text
 * instead of trusting the instruction.
 *
 * Deliberately GENEROUS, and this is the design, not a shortcut: both outcomes
 * mean "a human is needed on this card". A false positive costs violet instead
 * of amber; it never costs a card that keeps claiming to work. Precision would
 * be worth paying for only if one branch were silent, and neither is.
 */

/** How far back from the end of the message the question may be.
 *
 *  Long enough to reach past several paragraph-sized options to the question
 *  that introduced them — the exact shape that defeats a structured picker, and
 *  the reason this module exists. Short enough that a whole plan document
 *  pasted into chat is not swept for an incidental `?` in its opening. */
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
 * Drop fenced code blocks, keeping the prose around them.
 *
 * Line-wise rather than by regex on purpose. The regex form has to express "up
 * to the matching closer, or the end of the message if the fence was never
 * closed", and under the multiline flag every `$` in it also matches at every
 * line END — so a lazy body stops at the first newline and the rest of the block
 * leaks straight into the question window. Walking the lines says exactly what
 * it means and cannot be read two ways.
 *
 * A fence left open at the end swallows the remainder, which is the right
 * reading: whatever follows an unterminated fence is code the agent was still
 * writing, not a question it was asking.
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
    // Only a fence of the same character closes the block, so a ``` inside a
    // ~~~ block stays code.
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
