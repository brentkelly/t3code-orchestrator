/**
 * Pure brief text operations for the decider, plus the brief's version: a
 * content hash, because the body never rides the read model and a hash needs
 * no column to keep in step.
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
export function scanBriefLines(lines: ReadonlyArray<string>): {
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

/** The heading level an end-marker line closes (`<!-- end ## Notes -->` → 2),
    or null when the line is not an end marker. */
function briefEndMarkerLevel(line: string): number | null {
  const match = /^<!-- end (.+) -->$/.exec(line.trim());
  return match === null ? null : briefHeadingLevel(match[1]!);
}

/**
 * The first line in `body` that would end the section under `heading` (a
 * same-or-higher heading or end marker), or null. Such a body cannot be
 * replaced as one section: the next replace would stop there.
 */
export function briefSectionBodyBreak(heading: string, body: string): string | null {
  const level = briefHeadingLevel(heading.trim()) ?? 1;
  const marker = briefSectionEndMarker(heading);
  const lines = body.split("\n");
  for (const index of scanBriefLines(lines).structural) {
    const line = lines[index]!;
    const lineLevel = briefHeadingLevel(line) ?? briefEndMarkerLevel(line);
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
 * A section ends at its end marker, else at the next same-or-higher heading or
 * end marker; fenced headings are text. A missing heading is appended, so
 * repeating a call replaces. The caller validates `heading` and unclosed fences.
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
    const lineLevel = briefHeadingLevel(line) ?? briefEndMarkerLevel(line);
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
