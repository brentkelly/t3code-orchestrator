/**
 * The provider-usage bar's view model (T3O-22, D14) — pure, so every string the
 * top bar shows is decided here and asserted without rendering anything.
 *
 * The bar exists because a usage limit is a fact about a provider ACCOUNT, not
 * about any one card: it is what the board is waiting on, it holds every card
 * on that account, and until this shipped the only way to find out was to open a
 * card and read its chip. It appears ONLY while some provider is limited, so an
 * ordinary board's header is unchanged.
 */
import type { BoardCardShell, BoardProviderLimit, ProviderInstanceId } from "@t3tools/contracts";

export type BoardProviderUsageTask = {
  readonly cardId: string;
  readonly key: string;
  readonly title: string;
};

export type BoardProviderUsageRow = {
  readonly providerInstanceId: ProviderInstanceId;
  readonly name: string;
  /** A window that resets on its own — the only state with a countdown, a
      Resume now and a waiting list. */
  readonly limited: boolean;
  /** Out of credits (D16): no countdown, no Resume now, nothing to wait for. */
  readonly exhausted: boolean;
  readonly ok: boolean;
  /** The provider's OWN sentence, never our paraphrase: a human reading "Out of
      credits" wants to see what the provider actually said. */
  readonly detail: string;
  /** `tomorrow 1:00 AM`, or empty when the board is polling blind. */
  readonly resumeWhen: string;
  /** `in 1h 38m`, or empty when the board is polling blind. */
  readonly resumeIn: string;
  /** Whether the provider named a time. When it did not, the popover offers
      "Set resume time" instead of a countdown. */
  readonly knownTime: boolean;
  readonly resumeAt: string | null;
  readonly tasks: ReadonlyArray<BoardProviderUsageTask>;
  readonly taskCount: string;
};

export type BoardProviderUsageBar = {
  /** Only while something is limited or exhausted. */
  readonly show: boolean;
  /** `Anthropic limit`, or `2 provider limits`. */
  readonly label: string;
  /** The soonest reset time, as a bare clock. Empty when nothing has one. */
  readonly resume: string;
  readonly tip: string;
  readonly checked: string;
  readonly rows: ReadonlyArray<BoardProviderUsageRow>;
};

const clock = (ms: number) =>
  new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(ms);

/** `1:00 AM`, `tomorrow 1:00 AM`, or `Fri 1:00 AM` further out — the same
    shape the card's own schedule pill uses, so two controls describing the same
    instant never word it differently. */
export function boardUsageWhenLabel(iso: string, nowMs: number): string {
  const atMs = Date.parse(iso);
  if (!Number.isFinite(atMs)) return "";
  const days = calendarDaysBetween(nowMs, atMs);
  if (days <= 0) return clock(atMs);
  if (days === 1) return `tomorrow ${clock(atMs)}`;
  return `${new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(atMs)} ${clock(atMs)}`;
}

/** `in 1h 38m` / `in 12m` / `due now`. Coarse on purpose: this is a countdown a
    human glances at, and a ticking seconds figure would be a repainting
    animation on a header that is always on screen. */
export function boardUsageUntilLabel(iso: string, nowMs: number): string {
  const atMs = Date.parse(iso);
  if (!Number.isFinite(atMs)) return "";
  const ms = atMs - nowMs;
  if (ms <= 0) return "due now";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest === 0 ? `in ${hours}h` : `in ${hours}h ${rest}m`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `in ${days}d` : `in ${days}d ${restHours}h`;
}

/** How long ago the board last actually asked the provider — so a human can
    tell a live cooldown from a forgotten one. */
export function boardUsageCheckedLabel(iso: string | undefined, nowMs: number): string {
  if (iso === undefined) return "";
  const atMs = Date.parse(iso);
  if (!Number.isFinite(atMs)) return "";
  const minutes = Math.round(Math.max(0, nowMs - atMs) / 60_000);
  if (minutes < 1) return "checked just now";
  if (minutes < 60) return `checked ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `checked ${hours}h ago` : `checked ${Math.round(hours / 24)}d ago`;
}

function calendarDaysBetween(fromMs: number, toMs: number): number {
  const startOfDay = (ms: number) => {
    const parts = new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(ms);
    const read = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((part) => part.type === type)?.value ?? "0");
    return Date.UTC(read("year"), read("month") - 1, read("day"));
  };
  return Math.round((startOfDay(toMs) - startOfDay(fromMs)) / 86_400_000);
}

/**
 * Build the bar.
 *
 * The waiting list is the cards this cooldown is actually holding — a `stalled`
 * step whose reason is `usage-limit` and nothing else. That scoping is the same
 * one the server resumes on: a card sitting on an unanswered question is not
 * waiting on the provider, and saying it is would be a lie the human acts on.
 */
export function boardProviderUsageBar(input: {
  readonly limits: ReadonlyArray<BoardProviderLimit>;
  readonly cards: ReadonlyArray<BoardCardShell>;
  /** Resolves an instance id to its display name; falls back to the id. */
  readonly nameFor?: (instanceId: ProviderInstanceId) => string | undefined;
  readonly nowMs: number;
}): BoardProviderUsageBar {
  const rows = input.limits.map((limit): BoardProviderUsageRow => {
    const limited = limit.kind === "wait";
    // Scoped to THIS account. A card carries the instance holding it only while
    // its stall reason is `usage-limit`, which is exactly when this list is
    // about it — so a board with two limited providers never lists a card under
    // both, and a card parked on an unanswered question is never listed at all.
    const tasks = limited
      ? input.cards
          .filter(
            (card) =>
              card.archivedAt === null &&
              card.stalled &&
              card.stalledReason === "usage-limit" &&
              card.limitedByInstanceId === limit.providerInstanceId,
          )
          .map((card) => ({ cardId: String(card.cardId), key: card.key, title: card.title }))
      : [];
    return {
      providerInstanceId: limit.providerInstanceId,
      name: input.nameFor?.(limit.providerInstanceId) ?? String(limit.providerInstanceId),
      limited,
      exhausted: limit.kind === "exhausted",
      ok: false,
      detail: limit.reason ?? "",
      resumeWhen: limited && limit.knownTime ? boardUsageWhenLabel(limit.until, input.nowMs) : "",
      resumeIn: limited && limit.knownTime ? boardUsageUntilLabel(limit.until, input.nowMs) : "",
      knownTime: limit.knownTime,
      resumeAt: limited ? limit.until : null,
      tasks,
      taskCount: tasks.length === 1 ? "1 task waiting" : `${tasks.length} tasks waiting`,
    };
  });

  const waiting = rows.filter((row) => row.limited);
  const broke = rows.filter((row) => row.exhausted);
  const soonest = waiting
    .map((row) => row.resumeAt)
    .filter((at): at is string => at !== null && Number.isFinite(Date.parse(at)))
    .sort()[0];
  // The most recent check across every limit: the popover's line is about the
  // board's own liveness, so the freshest answer is the honest one.
  const checkedFrom = input.limits
    .map((limit) => limit.lastCheckedAt)
    .toSorted()
    .at(-1);

  return {
    show: rows.length > 0,
    label:
      rows.length === 1
        ? broke.length === 1
          ? `${rows[0]?.name ?? ""} — out of credits`
          : `${rows[0]?.name ?? ""} limit`
        : `${rows.length} provider limits`,
    // An exhausted account gets no clock: there is nothing to count down to,
    // and a time beside it would read as a promise the board cannot keep.
    resume: soonest === undefined ? "" : clock(Date.parse(soonest)),
    tip: rows
      .map((row) =>
        row.exhausted
          ? `${row.name} is out of credits — this needs a human`
          : row.knownTime
            ? `${row.name} usage limit — resuming ${row.resumeWhen} (${row.resumeIn})`
            : `${row.name} usage limit — no reset time given, the board is checking periodically`,
      )
      .join("\n"),
    checked: boardUsageCheckedLabel(checkedFrom, input.nowMs),
    rows,
  };
}
