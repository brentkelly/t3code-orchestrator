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

/** Indexes of the lines that are markdown structure: everything outside fenced
    code blocks, fence markers excluded. A heading inside a fence is text. */
function structuralLineIndexes(lines: ReadonlyArray<string>): Array<number> {
  const indexes: Array<number> = [];
  let fence: string | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(lines[index]!);
    if (fenceMatch !== null) {
      const marker = fenceMatch[1]!;
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (fence === null) indexes.push(index);
  }
  return indexes;
}

/**
 * The first heading line in a section `body` that would end the section under
 * `heading` — one of the same or a higher level — or null when there is none.
 * Such a body cannot be replaced as one section: the next replace stops at
 * that heading and leaves the rest behind as a duplicate.
 */
export function briefSectionBodyBreak(heading: string, body: string): string | null {
  const level = briefHeadingLevel(heading.trim()) ?? 1;
  const lines = body.split("\n");
  for (const index of structuralLineIndexes(lines)) {
    const lineLevel = briefHeadingLevel(lines[index]!);
    if (lineLevel !== null && lineLevel <= level) return lines[index]!.trim();
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
 * The section runs from its heading line to the next heading of the same or a
 * higher level (fewer `#`s), or the end of the brief. Headings inside fenced
 * code blocks are text, not structure, and are skipped. A heading that is not
 * there yet is appended as a new section, so repeating the same call replaces
 * the section instead of growing the brief. The first match wins; a brief that
 * somehow carries the heading twice keeps the second untouched.
 *
 * `heading` must be a heading line (`briefHeadingLevel` non-null) — the caller
 * validates, since the rejection belongs in an agent-facing message.
 */
export function replaceBriefSection(brief: string | null, heading: string, body: string): string {
  const target = heading.trim();
  const level = briefHeadingLevel(target) ?? 1;
  const section = body.trim().length === 0 ? target : `${target}\n\n${body.trim()}`;
  const lines = (brief ?? "").split("\n");

  let start = -1;
  let end = lines.length;
  for (const index of structuralLineIndexes(lines)) {
    const line = lines[index]!;
    if (start === -1) {
      if (line.trim() === target) start = index;
      continue;
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
