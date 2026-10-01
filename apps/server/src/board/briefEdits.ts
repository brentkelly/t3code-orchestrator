/**
 * T3o: incremental brief edits (T3O-53).
 *
 * Pure text operations the decider applies to a card's stored brief, plus the
 * brief's VERSION — an opaque content hash an agent reads alongside the brief
 * and hands back as `expectedBriefVersion`. A content hash rather than a
 * revision counter because the brief body never rides the read model (D8):
 * the engine loads the body for the one command that needs it, and the hash is
 * derivable from that body alone, with no column to migrate or keep in step.
 */

/** FNV-1a, 64-bit, over the UTF-16 code units. Not cryptographic — it only
    has to tell two briefs apart, and it is synchronous, so the decider stays a
    plain function of its inputs. */
export function boardBriefVersion(brief: string | null): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const text = brief ?? "";
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

/** The level of a markdown ATX heading line (`## Notes` → 2), or null when the
    line is not one. */
export function briefHeadingLevel(line: string): number | null {
  const match = /^(#{1,6})[ \t]+\S/.exec(line.trim());
  return match === null ? null : match[1]!.length;
}

/** The lines that are markdown structure — everything outside fenced code
    blocks, fence markers excluded, so a heading inside a fence is text — and
    the index of the line opening a fence that never closes, if any. */
function scanBriefLines(lines: ReadonlyArray<string>): {
  readonly structural: Array<number>;
  readonly unclosedFence: number | null;
} {
  const structural: Array<number> = [];
  let fence: string | null = null;
  let fenceStart = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(lines[index]!);
    if (fenceMatch !== null) {
      const marker = fenceMatch[1]!;
      if (fence === null) {
        fence = marker;
        fenceStart = index;
      } else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (fence === null) structural.push(index);
  }
  return { structural, unclosedFence: fence === null ? null : fenceStart };
}

/**
 * The line opening a code fence in `text` that never closes, or null. Every
 * heading after such a fence reads as code, so a section replace can no longer
 * tell where its section ends and would swallow everything after it.
 */
export function briefUnclosedFence(text: string | null): string | null {
  const lines = (text ?? "").split("\n");
  const { unclosedFence } = scanBriefLines(lines);
  return unclosedFence === null ? null : lines[unclosedFence]!.trim();
}

/**
 * The line closing a section `replaceBriefSection` writes. Without it the
 * section would run to the next heading or the end of the brief, so text
 * `briefAppend` adds after a trailing section would become part of it and the
 * next replace of that section would delete it.
 */
export function briefSectionEndMarker(heading: string): string {
  return `<!-- end ${heading.trim()} -->`;
}

/**
 * The first line in a section `body` that would end the section under
 * `heading` — a heading of the same or a higher level, or the section's end
 * marker — or null when there is none. Such a body cannot be replaced as one
 * section: the next replace stops at that line and leaves the rest behind as a
 * duplicate.
 */
export function briefSectionBodyBreak(heading: string, body: string): string | null {
  const level = briefHeadingLevel(heading.trim()) ?? 1;
  const marker = briefSectionEndMarker(heading);
  const lines = body.split("\n");
  for (const index of scanBriefLines(lines).structural) {
    const line = lines[index]!;
    const lineLevel = briefHeadingLevel(line);
    if ((lineLevel !== null && lineLevel <= level) || line.trim() === marker) return line.trim();
  }
  return null;
}

/** The brief with `text` appended after a blank line. */
export function appendToBrief(brief: string | null, text: string): string {
  const head = (brief ?? "").trimEnd();
  const tail = text.trim();
  return head.length === 0 ? tail : `${head}\n\n${tail}`;
}

/**
 * The brief with the section under `heading` replaced by `body`.
 *
 * The section runs from its heading line through its end marker
 * (`briefSectionEndMarker`), which this function writes after every section.
 * A section without one — written by hand, or before markers existed — runs
 * to the next heading of the same or a higher level (fewer `#`s), or the end
 * of the brief; a heading like that before the marker also ends the section,
 * so a hand-made heading inside it is kept rather than deleted. Headings inside fenced
 * code blocks are text, not structure, and are skipped. A heading that is not
 * there yet is appended as a new section, so repeating the same call replaces
 * the section instead of growing the brief. The first match wins; a brief that
 * somehow carries the heading twice keeps the second untouched.
 *
 * `heading` must be a heading line (`briefHeadingLevel` non-null), and neither
 * `brief` nor `body` may hold an unclosed fence (`briefUnclosedFence` null) —
 * the caller validates, since the rejection belongs in an agent-facing message.
 */
export function replaceBriefSection(brief: string | null, heading: string, body: string): string {
  const target = heading.trim();
  const level = briefHeadingLevel(target) ?? 1;
  const marker = briefSectionEndMarker(target);
  const section = [target, body.trim(), marker].filter((part) => part.length > 0).join("\n\n");
  const lines = (brief ?? "").split("\n");

  let start = -1;
  let end = lines.length;
  for (const index of scanBriefLines(lines).structural) {
    const line = lines[index]!;
    if (start === -1) {
      if (line.trim() === target) start = index;
      continue;
    }
    if (line.trim() === marker) {
      end = index + 1;
      break;
    }
    const lineLevel = briefHeadingLevel(line);
    if (lineLevel !== null && lineLevel <= level) {
      end = index;
      break;
    }
  }

  if (start === -1) return appendToBrief(brief, section);

  const before = lines.slice(0, start).join("\n").trimEnd();
  const after = lines.slice(end).join("\n").trim();
  return [before, section, after].filter((part) => part.length > 0).join("\n\n");
}
