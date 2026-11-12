/**
 * Patching a plan body without resending it (`board_edit_plan`). Unlike
 * `replaceBriefSection`, a section edit's text includes its heading, a missing
 * heading is an error rather than an append, and `<!-- end … -->` lines are
 * ordinary text.
 */
import { briefHeadingLevel, briefUnclosedFence, scanBriefLines } from "./briefEdits.ts";

export interface BoardPlanEdit {
  readonly old_text?: string | undefined;
  readonly section?: string | undefined;
  readonly new_text: string;
  readonly replace_all?: boolean | undefined;
}

export type BoardPlanEditResult =
  | { readonly ok: true; readonly body: string }
  | { readonly ok: false; readonly index: number | null; readonly message: string };

const HEADINGS_LISTED_MAX = 40;

const normaliseNewlines = (text: string): string => text.replace(/\r\n/g, "\n");

/** A heading line compared on its text: trailing whitespace and an ATX
    closing sequence (`## Name ##`) do not count. */
const headingKey = (line: string): string => line.trim().replace(/[ \t]+#+$/, "");

const countOccurrences = (haystack: string, needle: string): number => {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) {
    count += 1;
  }
  return count;
};

const collapseWhitespace = (text: string): string => text.replace(/\s+/g, " ").trim();

function applyTextEdit(
  body: string,
  oldText: string,
  newText: string,
  replaceAll: boolean,
): { readonly body: string } | { readonly error: string } {
  const count = countOccurrences(body, oldText);
  if (count === 0) {
    const nearMatch =
      collapseWhitespace(oldText).length > 0 &&
      collapseWhitespace(body).includes(collapseWhitespace(oldText));
    return {
      error: nearMatch
        ? "old_text not found; a match exists that differs only in whitespace, copy it exactly from board_get_plan"
        : "old_text not found",
    };
  }
  if (count > 1 && !replaceAll) {
    return {
      error: `old_text matches ${count} times; include more surrounding text or set replace_all`,
    };
  }
  // split/join, never String.replace: a `$&` in new_text must stay literal.
  return { body: body.split(oldText).join(newText) };
}

function applySectionEdit(
  body: string,
  section: string,
  newText: string,
): { readonly body: string } | { readonly error: string } {
  const unclosed = briefUnclosedFence(body);
  if (unclosed !== null) {
    return {
      error: `the plan has an unclosed code fence at "${unclosed}"; fix it with a text edit first`,
    };
  }
  const level = briefHeadingLevel(section);
  if (level === null) {
    return { error: 'section must be a markdown heading line like "## Name"' };
  }
  const target = headingKey(section);
  const lines = body.split("\n");
  const headings = scanBriefLines(lines).structural.filter(
    (index) => briefHeadingLevel(lines[index]!) !== null,
  );
  const matches = headings.filter((index) => headingKey(lines[index]!) === target);
  if (matches.length === 0) {
    const listed = headings.slice(0, HEADINGS_LISTED_MAX).map((index) => lines[index]!.trim());
    const more = headings.length > HEADINGS_LISTED_MAX ? ", …" : "";
    return {
      error:
        listed.length === 0
          ? `no heading "${target}"; the plan has no headings`
          : `no heading "${target}"; headings are: ${listed.join(", ")}${more}`,
    };
  }
  if (matches.length > 1) {
    return {
      error: `heading "${target}" appears ${matches.length} times; use a text edit with more context`,
    };
  }
  const start = matches[0]!;
  const end =
    headings.find((index) => index > start && briefHeadingLevel(lines[index]!)! <= level) ??
    lines.length;

  const before = lines.slice(0, start).join("\n");
  const after = lines.slice(end).join("\n");
  const hasAfter = end < lines.length;
  let replacement = newText;
  if (replacement.length > 0 && hasAfter && !replacement.endsWith("\n")) replacement += "\n";
  const head = start === 0 ? "" : `${before}\n`;
  return { body: hasAfter ? `${head}${replacement}${after}` : `${head}${replacement}` };
}

/** Applies `edits` in order, all or nothing. */
export function applyBoardPlanEdits(
  rawBody: string,
  edits: ReadonlyArray<BoardPlanEdit>,
): BoardPlanEditResult {
  const original = normaliseNewlines(rawBody);
  let body = original;
  for (const [index, edit] of edits.entries()) {
    const oldText = edit.old_text === undefined ? "" : normaliseNewlines(edit.old_text);
    const section = edit.section === undefined ? "" : normaliseNewlines(edit.section);
    const newText = normaliseNewlines(edit.new_text);
    if ((oldText.length > 0) === (section.length > 0)) {
      return {
        ok: false,
        index,
        message: `edits[${index}]: set exactly one of old_text or section`,
      };
    }
    const result =
      oldText.length > 0
        ? applyTextEdit(body, oldText, newText, edit.replace_all === true)
        : applySectionEdit(body, section, newText);
    if ("error" in result) {
      return { ok: false, index, message: `edits[${index}]: ${result.error}` };
    }
    body = result.body;
  }
  if (body === original) {
    return { ok: false, index: null, message: "edits made no change to the plan" };
  }
  return { ok: true, body };
}
