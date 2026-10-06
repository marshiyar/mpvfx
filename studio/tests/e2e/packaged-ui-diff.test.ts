import { describe, expect, it } from "vitest";
import { encodePng } from "./png-rgba.mjs";
import { comparePackagedUi } from "./packaged-ui-diff.mjs";

const width = 100, height = 100;
const plain = Buffer.alloc(width * height * 4);
for (let offset = 3; offset < plain.length; offset += 4) plain[offset] = 255;
const screenshot = encodePng(width, height, plain);

describe("packaged UI comparison sensitivity", () => {
  it("accepts identical evidence", () => {
    const result = comparePackagedUi(screenshot, screenshot, { editor: 300 }, { editor: 300 });
    expect(result.accepted).toBe(true);
    expect(result.changedPercent).toBe(0);
  });

  it("rejects a deliberate 3% visual regression", () => {
    const changed = Buffer.from(plain);
    for (let pixel = 0; pixel < 300; pixel++) changed[pixel * 4] = 255;
    const result = comparePackagedUi(screenshot, encodePng(width, height, changed), { editor: 300 }, { editor: 300 });
    expect(result.changedPercent).toBe(3);
    expect(result.accepted).toBe(false);
  });

  it("rejects a shifted editor panel even when pixels are identical", () => {
    const result = comparePackagedUi(screenshot, screenshot, { editor: 300 }, { editor: 305 });
    expect(result.shiftedLayoutFields).toEqual(["editor"]);
    expect(result.accepted).toBe(false);
  });
});
