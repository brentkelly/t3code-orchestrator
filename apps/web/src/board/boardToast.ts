/**
 * Board toasts: neutral for information, red-tinted for errors, amber for a
 * partial failure, each with optional actions ("Open", "Retry"). Errors linger
 * longer — 9s against 6s — because a human has to read them to act; a
 * persistent toast stays until its × is pressed.
 */
import { toastManager } from "../components/ui/toast";

const BOARD_TOAST_TIMEOUT_MS = 6_000;
const BOARD_TOAST_ERROR_TIMEOUT_MS = 9_000;

interface BoardToastAction {
  readonly label: string;
  readonly run: () => void;
}

export function boardToast(input: {
  readonly title: string;
  /** The grey second line. */
  readonly description?: string | undefined;
  readonly tone?: "info" | "error" | "warning" | undefined;
  readonly action?: BoardToastAction | undefined;
  /** T3o: several text-link actions; the first is the primary (T3O-117). */
  readonly actions?: ReadonlyArray<BoardToastAction> | undefined;
  /** Stays until dismissed with ×, for a failure the human must act on. */
  readonly persistent?: boolean | undefined;
}): void {
  const tone = input.tone ?? "info";
  const actions = input.actions ?? (input.action === undefined ? [] : [input.action]);
  const [primary, ...rest] = actions;
  const run = (action: BoardToastAction) => () => {
    toastManager.close(id);
    action.run();
  };
  const id = toastManager.add({
    type: tone,
    title: input.title,
    ...(input.description === undefined ? {} : { description: input.description }),
    timeout:
      input.persistent === true
        ? 0
        : tone === "info"
          ? BOARD_TOAST_TIMEOUT_MS
          : BOARD_TOAST_ERROR_TIMEOUT_MS,
    ...(primary === undefined
      ? {}
      : { actionProps: { children: primary.label, onClick: run(primary) } }),
    ...(rest.length === 0
      ? {}
      : {
          data: {
            additionalActions: rest.map((action) => ({
              id: action.label,
              props: { children: action.label, onClick: run(action) },
            })),
          },
        }),
  });
}
