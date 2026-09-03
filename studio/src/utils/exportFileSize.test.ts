import { describe, expect, it } from "vitest";
import { formatExportFileSize } from "./exportPolicy";

describe("standalone export file size display", () => {
  it.each([
    [0, "0 B"],
    [999, "999 B"],
    [1024, "1 KB"],
    [1536, "1.5 KB"],
    [1024 ** 2, "1 MB"],
    [2.5 * 1024 ** 3, "2.5 GB"],
  ] as const)("formats %s bytes as %s", (bytes, expected) => {
    expect(formatExportFileSize(bytes)).toBe(expected);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    "does not display invalid byte count %s",
    (bytes) => expect(formatExportFileSize(bytes)).toBe("Unknown size"),
  );
});
