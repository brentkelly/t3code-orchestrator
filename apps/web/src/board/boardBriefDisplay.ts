/**
 * The brief as the read-only view shows it: the server's section end markers
 * (`briefSectionEndMarker`) are hidden so nobody deletes them by hand; the
 * editor keeps them.
 */
const END_MARKER_LINE = /^<!-- end #{1,6}\s.*-->$/;

export function boardBriefDisplayText(brief: string): string {
  return brief
    .split("\n")
    .filter((line) => !END_MARKER_LINE.test(line.trim()))
    .join("\n");
}
