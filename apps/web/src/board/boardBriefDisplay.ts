/**
 * The brief as the read-only view shows it (T3O-53).
 *
 * An agent's section replace closes each section with an end-marker comment
 * (`<!-- end ## Notes from Z5-34 -->`, written by the server's
 * `briefSectionEndMarker` in apps/server/src/board/briefEdits.ts). The brief
 * renders as plain text, so the marker would show literally and invite a human
 * to delete it, which quietly drops the section back to the heading-based end
 * rule. The view hides those lines; the editor keeps them.
 */
const END_MARKER_LINE = /^<!-- end #{1,6}\s.*-->$/;

export function boardBriefDisplayText(brief: string): string {
  return brief
    .split("\n")
    .filter((line) => !END_MARKER_LINE.test(line.trim()))
    .join("\n");
}
