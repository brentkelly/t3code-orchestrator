/**
 * ANSI colour in CI logs: the 16 basic SGR colours and bold become
 * theme classes; every other escape (cursor moves, 256-colour and true colour,
 * backgrounds, OSC titles and links) is stripped. A colour carries across
 * lines, so a block is read with one running state.
 */

export interface BoardCiAnsiSegment {
  readonly text: string;
  /** Null is plain text. */
  readonly className: string | null;
}

export interface BoardCiAnsiState {
  /** 0–7 normal, 8–15 bright, or null for the default colour. */
  readonly fg: number | null;
  readonly bold: boolean;
}

export const BOARD_CI_ANSI_RESET: BoardCiAnsiState = { fg: null, bold: false };

const FG_CLASS: ReadonlyArray<string> = [
  "text-foreground",
  "text-red-600 dark:text-red-400",
  "text-green-700 dark:text-green-400",
  "text-amber-700 dark:text-amber-300",
  "text-blue-600 dark:text-blue-400",
  "text-fuchsia-600 dark:text-fuchsia-400",
  "text-cyan-700 dark:text-cyan-400",
  "text-muted-foreground",
  "text-muted-foreground",
  "text-red-500 dark:text-red-300",
  "text-green-600 dark:text-green-300",
  "text-amber-600 dark:text-amber-200",
  "text-blue-500 dark:text-blue-300",
  "text-fuchsia-500 dark:text-fuchsia-300",
  "text-cyan-600 dark:text-cyan-300",
  "text-foreground",
];

// CSI (`ESC [ … final`), OSC (`ESC ] … BEL|ST`), any other two-byte escape,
// and the C0 controls a log viewer can't show (a tab stays).
const ESCAPES =
  /\u001b\[([0-?]*)[ -/]*([@-~])|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-Z\\-_]?|[\u0000-\u0008\u000b-\u001f\u007f]/g;

function classOf(state: BoardCiAnsiState): string | null {
  const color = state.fg === null ? null : FG_CLASS[state.fg]!;
  if (!state.bold) return color;
  return color === null ? "font-semibold" : `${color} font-semibold`;
}

function applySgr(state: BoardCiAnsiState, params: string): BoardCiAnsiState {
  const codes = params.length === 0 ? [0] : params.split(/[;:]/).map((code) => Number(code) || 0);
  let { fg, bold } = state;
  for (let index = 0; index < codes.length; index++) {
    const code = codes[index]!;
    if (code === 0) {
      fg = null;
      bold = false;
    } else if (code === 1) bold = true;
    else if (code === 22) bold = false;
    else if (code >= 30 && code <= 37) fg = code - 30;
    else if (code >= 90 && code <= 97) fg = code - 90 + 8;
    else if (code === 39) fg = null;
    else if (code === 38 || code === 48) {
      // Extended colours aren't shown; skip their arguments.
      index += codes[index + 1] === 5 ? 2 : codes[index + 1] === 2 ? 4 : 0;
    }
  }
  return fg === state.fg && bold === state.bold ? state : { fg, bold };
}

/** One line's segments, starting from `state`, and the state after it. */
export function ansiToSegments(
  line: string,
  state: BoardCiAnsiState = BOARD_CI_ANSI_RESET,
): { readonly segments: ReadonlyArray<BoardCiAnsiSegment>; readonly state: BoardCiAnsiState } {
  const segments: BoardCiAnsiSegment[] = [];
  let current = state;
  let cursor = 0;
  const push = (end: number) => {
    if (end <= cursor) return;
    const text = line.slice(cursor, end);
    const className = classOf(current);
    const last = segments.at(-1);
    if (last !== undefined && last.className === className) {
      segments[segments.length - 1] = { text: last.text + text, className };
    } else {
      segments.push({ text, className });
    }
  };
  ESCAPES.lastIndex = 0;
  for (let match = ESCAPES.exec(line); match !== null; match = ESCAPES.exec(line)) {
    push(match.index);
    if (match[2] === "m") current = applySgr(current, match[1] ?? "");
    cursor = match.index + match[0].length;
  }
  push(line.length);
  return { segments, state: current };
}
