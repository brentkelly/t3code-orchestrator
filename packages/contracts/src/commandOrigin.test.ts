/**
 * The last test mints an id exactly as `supervisorReactor` does, so a change to that
 * minting fails here rather than turning every board nudge into a human steer.
 */
import { describe, expect, it } from "@effect/vitest";

import {
  BOARD_COMMAND_ID_PREFIX,
  commandIdOrigin,
  isBoardMintedCommandId,
} from "./commandOrigin.ts";

describe("commandIdOrigin", () => {
  it("reads the provider and server prefixes", () => {
    expect(commandIdOrigin("provider:claude:turn-1")).toBe("provider");
    expect(commandIdOrigin("server:board-recover-step:abc")).toBe("server");
    expect(commandIdOrigin("server:thread-release:abc")).toBe("server");
  });

  it("declares nothing for a client's bare UUID, or for no id at all", () => {
    expect(commandIdOrigin("8c7f0f0e-6d2b-4a5e-9a1d-0f2b3c4d5e6f")).toBeNull();
    expect(commandIdOrigin(null)).toBeNull();
    expect(commandIdOrigin(undefined)).toBeNull();
  });

  it("matches on the prefix, not anywhere in the id", () => {
    // A client id that merely CONTAINS the word must not be read as one.
    expect(commandIdOrigin("8c7f-server:board-x")).toBeNull();
  });
});

describe("isBoardMintedCommandId", () => {
  it("recognises the shape the supervisor reactor mints", () => {
    // Exactly `commandId(tag)` in `supervisorReactor.ts`:
    // `server:board-${tag}:${uuid}`.
    const tag = "recover-step";
    const uuid = "8c7f0f0e-6d2b-4a5e-9a1d-0f2b3c4d5e6f";
    expect(isBoardMintedCommandId(`server:board-${tag}:${uuid}`)).toBe(true);
    expect(`server:board-${tag}:${uuid}`.startsWith(BOARD_COMMAND_ID_PREFIX)).toBe(true);
  });

  it("rejects a client id, another server subsystem's id, and no id", () => {
    expect(isBoardMintedCommandId("8c7f0f0e-6d2b-4a5e-9a1d-0f2b3c4d5e6f")).toBe(false);
    expect(isBoardMintedCommandId("server:thread-release:abc")).toBe(false);
    // Unknown reads as NOT the board's, deliberately: the board always stamps
    // an id, and the dangerous direction is mistaking a human's turn for a
    // nudge, which would suppress nothing.
    expect(isBoardMintedCommandId(null)).toBe(false);
    expect(isBoardMintedCommandId(undefined)).toBe(false);
  });

  it("is a strict subset of the server origin", () => {
    expect(commandIdOrigin(`${BOARD_COMMAND_ID_PREFIX}pause-step:abc`)).toBe("server");
  });
});
