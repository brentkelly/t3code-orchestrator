export type MobileStageLabel = "Beta" | "Dev" | "Nightly" | "T3o";

export function resolveMobileStageLabel(appVariant: unknown): MobileStageLabel {
  if (appVariant === "development") return "Dev";
  if (appVariant === "preview") return "Nightly";
  // T3o: dedicated flavour, not a production T3 Code beta.
  if (appVariant === "t3o") return "T3o";
  return "Beta";
}
