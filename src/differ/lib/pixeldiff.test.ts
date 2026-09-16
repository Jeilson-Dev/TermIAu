import { describe, expect, it } from "vitest";
import { pixelDiff, type Pixels } from "./pixeldiff";

/** Solid image; `paint` overrides single pixels as [x, y, r, g, b, a]. */
function image(width: number, height: number, paint: number[][] = []): Pixels {
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (const [x, y, r, g, b, a] of paint) data.set([r, g, b, a], (y * width + x) * 4);
  return { data, width, height };
}

describe("pixelDiff", () => {
  it("finds no change between identical images", () => {
    const result = pixelDiff(image(3, 2), image(3, 2));
    expect(result.changed).toBe(0);
    expect(result.total).toBe(6);
    expect(result.bounds).toBeNull();
  });

  it("highlights changed pixels and boxes them", () => {
    const result = pixelDiff(image(4, 4), image(4, 4, [[1, 2, 0, 0, 0, 255], [3, 3, 10, 10, 10, 255]]));
    expect(result.changed).toBe(2);
    expect(result.bounds).toEqual({ x: 1, y: 2, width: 3, height: 2 });
    expect([...result.data.slice((2 * 4 + 1) * 4, (2 * 4 + 1) * 4 + 4)]).toEqual([255, 121, 198, 255]);
  });

  it("counts area covered by only one image as changed", () => {
    const result = pixelDiff(image(2, 2), image(3, 2));
    expect(result.width).toBe(3);
    expect(result.changed).toBe(2);
  });

  it("treats fully transparent pixels as equal regardless of color", () => {
    const result = pixelDiff(image(1, 1, [[0, 0, 255, 0, 0, 0]]), image(1, 1, [[0, 0, 0, 0, 255, 0]]));
    expect(result.changed).toBe(0);
  });
});
