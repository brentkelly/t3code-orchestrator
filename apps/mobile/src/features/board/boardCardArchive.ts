import type { ConfirmDialogRequest } from "../../components/ui/Dialog.types";

/** Archive after a confirm when live cards still depend on this one. */
export function requestBoardCardArchive(input: {
  readonly needsConfirmation: boolean;
  readonly confirm: (request: ConfirmDialogRequest) => void;
  readonly go: () => void;
}): void {
  if (input.needsConfirmation) {
    input.confirm({
      title: "Archive this card?",
      message: "Live cards still depend on it.",
      confirmText: "Archive",
      onConfirm: input.go,
    });
    return;
  }
  input.go();
}
