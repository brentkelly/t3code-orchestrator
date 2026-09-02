import { describe, expect, it } from "vite-plus/test";

import {
  boardAttachmentLimits,
  formatBoardAttachmentSize,
  pastedImageFiles,
} from "./boardAttachmentUpload";

describe("boardAttachmentLimits", () => {
  it("is unknown until the server config arrives", () => {
    expect(boardAttachmentLimits(null)).toEqual({
      known: false,
      enabled: false,
      maxFileBytes: null,
    });
  });

  it("clamps the advertised file limit to the contract cap", () => {
    expect(
      boardAttachmentLimits({ attachmentUploads: true, fileAttachments: { maxUploadBytes: 1024 } }),
    ).toEqual({ known: true, enabled: true, maxFileBytes: 1024 });
    expect(
      boardAttachmentLimits({
        attachmentUploads: true,
        fileAttachments: { maxUploadBytes: 500 * 1024 * 1024 },
      }).maxFileBytes,
    ).toBe(50 * 1024 * 1024);
  });

  it("accepts images but no files on a server without file uploads", () => {
    expect(boardAttachmentLimits({ attachmentUploads: true })).toEqual({
      known: true,
      enabled: true,
      maxFileBytes: null,
    });
  });
});

describe("formatBoardAttachmentSize", () => {
  it("formats B / KB / MB like the prototype", () => {
    expect(formatBoardAttachmentSize(512)).toBe("512 B");
    expect(formatBoardAttachmentSize(74 * 1024)).toBe("74 KB");
    expect(formatBoardAttachmentSize(8.1 * 1024 * 1024)).toBe("8.1 MB");
  });
});

describe("pastedImageFiles", () => {
  it("claims images only, so a pasted document falls through to text", () => {
    const image = new File(["x"], "shot.png", { type: "image/png" });
    const doc = new File(["x"], "doc.pdf", { type: "application/pdf" });
    const data = { files: [image, doc] } as unknown as DataTransfer;
    expect(pastedImageFiles(data)).toEqual([image]);
    expect(pastedImageFiles(null)).toEqual([]);
  });
});
