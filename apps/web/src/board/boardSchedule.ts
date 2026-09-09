/**
 * The pure half of a card's scheduled start (T3O-19): the labels, the presets
 * and the copy, with no React and no clock of its own.
 *
 * Every function takes its "now" so the tests are deterministic and the
 * renderer decides how often to ask. That is what lets the pill's label be a
 * fixed string — `9:00 PM`, `tomorrow 8:00 AM` — rather than a relative one
 * that either repaints continuously or goes stale. Only the tooltip carries the
 * relative reading, computed once at render (D11).
 *
 * Times round-trip through the CLIENT's timezone: `datetime-local` has no zone,
 * so the local wall-clock string is parsed with the browser's own offset into a
 * UTC instant, and the server only ever compares instants. A phone in another
 * timezone is correct with no server configuration (D12).
 */
import type { BoardStepStatus } from "@t3tools/contracts";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const pad2 = (value: number) => (value < 10 ? `0${String(value)}` : String(value));

/** A `Date` as the `datetime-local` input wants it: local wall clock, no zone. */
export function toLocalInputValue(date: Date): string {
  return `${String(date.getFullYear())}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** A `datetime-local` value back to a `Date`, or null when it is incomplete —
    which it is on every keystroke while the user is still typing one. */
export function fromLocalInputValue(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (match === null) return null;
  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
  );
  return Number.isNaN(date.getTime()) ? null : date;
}

/** The stored UTC instant as the input's local wall clock, and back. The pair
    is what makes a time set on a laptop read correctly on a phone in another
    zone: only the instant crosses the wire. */
export function isoToLocalInputValue(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : toLocalInputValue(date);
}

export function localInputValueToIso(value: string): string | null {
  return fromLocalInputValue(value)?.toISOString() ?? null;
}

const clockLabel = (date: Date) => {
  const hours = date.getHours();
  const suffix = hours < 12 ? "AM" : "PM";
  return `${String(hours % 12 || 12)}:${pad2(date.getMinutes())} ${suffix}`;
};

/**
 * The pill's label, which must stay true without a timer (D11).
 *
 * Today is the clock alone, tomorrow says so, the rest of the week names the
 * day, and anything further carries the date. Nothing here changes as time
 * passes except across a midnight, so thirty of these on a board repaint only
 * when the card itself does.
 */
export function whenLabel(iso: string, nowMs: number): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date(nowMs);
  const days = Math.round(
    (new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() -
      new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) /
      86_400_000,
  );
  if (days === 0) return clockLabel(date);
  if (days === 1) return `tomorrow ${clockLabel(date)}`;
  if (days > 1 && days < 7) return `${WEEKDAYS[date.getDay()]!} ${clockLabel(date)}`;
  return `${String(date.getDate())} ${MONTHS[date.getMonth()]!}, ${clockLabel(date)}`;
}

/** How long until it fires — the tooltip's half, and the only relative reading
    anywhere, so nothing on the board has to tick. */
export function untilLabel(iso: string, nowMs: number): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const minutes = Math.round((date.getTime() - nowMs) / 60_000);
  if (minutes <= 0) return "due now";
  if (minutes < 60) return `in ${String(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return `in ${String(hours)}h${rest === 0 ? "" : ` ${String(rest)}m`}`;
  }
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return `in ${String(days)}d${rest === 0 ? "" : ` ${String(rest)}h`}`;
}

export interface BoardSchedulePreset {
  readonly label: string;
  readonly iso: string;
}

/**
 * The three quick picks (D12), rounded to a sensible boundary so the picker
 * never lands on 9:37.
 *
 * The prototype's fourth — "When the limit resets" — is deliberately absent:
 * the board has no notion of a provider usage limit anywhere, so a preset
 * claiming to know when one resets would be inventing a fact.
 */
export function schedulePresets(nowMs: number): ReadonlyArray<BoardSchedulePreset> {
  const inAnHour = new Date(nowMs + 60 * 60_000);
  inAnHour.setSeconds(0, 0);
  inAnHour.setMinutes(Math.ceil(inAnHour.getMinutes() / 15) * 15);
  return [
    { label: "In 1 hour", iso: inAnHour.toISOString() },
    { label: "Tonight 9:00 PM", iso: atNextHour(nowMs, 21).toISOString() },
    { label: "Tomorrow 8:00 AM", iso: atNextHour(nowMs, 8).toISOString() },
  ];
}

function atNextHour(nowMs: number, hour: number): Date {
  const date = new Date(nowMs);
  date.setSeconds(0, 0);
  date.setMinutes(0);
  if (date.getHours() >= hour) date.setDate(date.getDate() + 1);
  date.setHours(hour);
  return date;
}

/**
 * What the popover is offering, derived from where the card's work actually
 * stands (D13). Four situations, and the copy has to be honest about each —
 * most of all `live`, where setting a time STOPS the agent, and the control
 * must say so before the click rather than after.
 */
export type BoardScheduleKind = "before-build" | "waiting" | "live" | "parked";

export function boardScheduleKind(input: {
  /** Whether the card has reached the stage that runs build-mode work. Before
      it, nothing has been admitted and the schedule gates THE BUILD. */
  readonly atOrAfterBuild: boolean;
  /** The card's live step status, or null when it has none yet. */
  readonly stepStatus: BoardStepStatus | null;
}): BoardScheduleKind {
  const status = input.stepStatus;
  if (status === "running") return "live";
  if (status === "stalled" || status === "awaiting-input" || status === "paused") return "parked";
  return input.atOrAfterBuild ? "waiting" : "before-build";
}

export interface BoardScheduleCopy {
  readonly title: string;
  readonly note: string;
  readonly clearLabel: string;
  /** The trigger's tooltip when nothing is set. */
  readonly emptyTip: string;
}

/** Every string the control shows, for one situation and one stage name. */
export function boardScheduleCopy(kind: BoardScheduleKind, stageLabel: string): BoardScheduleCopy {
  switch (kind) {
    case "before-build":
      return {
        title: "Start the build at",
        // The promise the gate actually keeps: plan-mode steps are never
        // withheld, so a card still in Backlog or Planning needs a human to
        // walk it to Ready before a scheduled time can do anything.
        note: "No effect unless the card has reached Ready or Building by then — planning and approval still need you.",
        clearLabel: "Clear — build when free",
        emptyTip: "Schedule the build to start",
      };
    case "waiting":
      return {
        title: `Start ${stageLabel} at`,
        note: `Holds ${stageLabel.toLowerCase()} until then. It starts on its own once the time passes and an agent is free.`,
        clearLabel: "Clear — start when free",
        emptyTip: `Schedule ${stageLabel.toLowerCase()} to start`,
      };
    case "live":
      return {
        title: "Pause and resume at",
        // The one that matters. No confirm dialog: clearing resumes the card
        // immediately, and that reversibility is what makes a confirm
        // unnecessary — but only if the copy says what the click does.
        note: "Stops the agent now and picks it up again at that time.",
        clearLabel: "Clear — keep working",
        emptyTip: "Pause this card and resume it later",
      };
    case "parked":
      return {
        title: `Resume ${stageLabel} at`,
        note: `Picks ${stageLabel.toLowerCase()} up where it stopped.`,
        clearLabel: "Clear — resume now",
        emptyTip: `Schedule ${stageLabel.toLowerCase()} to resume`,
      };
  }
}

/** The trigger's tooltip once a time is set: what will happen, when, and how
    long away — the one place the relative reading appears. */
export function boardScheduleSetTip(input: {
  readonly kind: BoardScheduleKind;
  readonly stageLabel: string;
  readonly iso: string;
  readonly nowMs: number;
}): string {
  const when = `${whenLabel(input.iso, input.nowMs)} · ${untilLabel(input.iso, input.nowMs)}`;
  const what =
    input.kind === "before-build"
      ? "Starts the build"
      : input.kind === "waiting"
        ? `Starts ${input.stageLabel.toLowerCase()}`
        : `Resumes ${input.stageLabel.toLowerCase()}`;
  return `${what} ${when} — click to change`;
}
