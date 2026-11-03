/**
 * Board toasts (T3O-29): neutral for information, red-tinted for errors, each
 * with an optional action ("Open", "Open board"). Errors linger longer — 9s
 * against 6s — because they are the ones a human has to read to act on.
 */
import { toastManager } from "../components/ui/toast";

export const BOARD_TOAST_TIMEOUT_MS = 6_000;
export const BOARD_TOAST_ERROR_TIMEOUT_MS = 9_000;

export function boardToast(input: {
  readonly title: string;
  readonly description?: string | undefined;
  readonly tone?: "info" | "error" | undefined;
  readonly action?: { readonly label: string; readonly run: () => void } | undefined;
}): void {
  const error = input.tone === "error";
  const id = toastManager.add({
    type: error ? "error" : "info",
    title: input.title,
    ...(input.description === undefined ? {} : { description: input.description }),
    timeout: error ? BOARD_TOAST_ERROR_TIMEOUT_MS : BOARD_TOAST_TIMEOUT_MS,
    ...(input.action === undefined
      ? {}
      : {
          actionProps: {
            children: input.action.label,
            onClick: () => {
              toastManager.close(id);
              input.action?.run();
            },
          },
        }),
  });
}
