import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { normalizeAbbreviationInput, workerNameProblems } from "./workerNames";

const BUILD = EnvironmentId.make("env-build-03");

describe("worker label and abbreviation", () => {
  const workers = [
    { id: BUILD, label: "build-03", abbreviation: "B03" },
    { id: EnvironmentId.make("env-mac"), label: "mac-mini", abbreviation: "MAC" },
  ];
  const check = (workerId: string, label: string, abbreviation: string) =>
    workerNameProblems({ workerId: workerId as never, label, abbreviation, workers });

  it.each([
    ["accepts its own abbreviation", "env-build-03", "build-03", "B03", null, null],
    ["accepts a free one", "env-build-03", "build-03", "B3", null, null],
    ["needs a label", "env-build-03", "  ", "B03", "Give the worker a label.", null],
    [
      "needs 1–3 letters or digits",
      "env-build-03",
      "build-03",
      "",
      null,
      "Use 1–3 letters or digits.",
    ],
    [
      "names who holds a duplicate",
      "env-build-03",
      "b",
      "MAC",
      null,
      "MAC is already used by mac-mini.",
    ],
    ["reserves SRV", "env-build-03", "b", "SRV", null, "SRV is reserved for this server."],
    ["keeps SRV on this server", "local", "Studio", "STU", null, "This server keeps SRV."],
    ["lets this server keep SRV", "local", "Studio", "SRV", null, null],
  ] as const)("%s", (_name, workerId, label, abbreviation, labelProblem, abbreviationProblem) => {
    expect(check(workerId, label, abbreviation)).toEqual({
      label: labelProblem,
      abbreviation: abbreviationProblem,
    });
  });

  it("forces abbreviation input to uppercase letters and digits", () => {
    expect(normalizeAbbreviationInput("b-0 3x")).toBe("B03");
  });
});
