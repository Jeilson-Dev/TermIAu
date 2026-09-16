export interface Pixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface PixelDiffResult {
  /** RGBA image: the new version faded out, changed pixels painted with the highlight color. */
  data: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
  changed: number;
  total: number;
  /** Smallest rectangle containing every changed pixel. */
  bounds: { x: number; y: number; width: number; height: number } | null;
}

const HIGHLIGHT = [255, 121, 198]; // Dracula pink
const FADED_ALPHA = 0.28;

/** Compares two images pixel by pixel; areas covered by only one of them count as changed. */
export function pixelDiff(before: Pixels, after: Pixels): PixelDiffResult {
  const width = Math.max(before.width, after.width);
  const height = Math.max(before.height, after.height);
  const data = new Uint8ClampedArray(width * height * 4);
  let changed = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inBefore = x < before.width && y < before.height;
      const inAfter = x < after.width && y < after.height;
      const b = (y * before.width + x) * 4;
      const a = (y * after.width + x) * 4;
      const o = (y * width + x) * 4;

      if (!inBefore || !inAfter || !samePixel(before.data, b, after.data, a)) {
        changed++;
        data[o] = HIGHLIGHT[0];
        data[o + 1] = HIGHLIGHT[1];
        data[o + 2] = HIGHLIGHT[2];
        data[o + 3] = 255;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      } else {
        const gray = Math.round(
          0.299 * after.data[a] + 0.587 * after.data[a + 1] + 0.114 * after.data[a + 2],
        );
        data[o] = gray;
        data[o + 1] = gray;
        data[o + 2] = gray;
        data[o + 3] = Math.round(after.data[a + 3] * FADED_ALPHA);
      }
    }
  }

  return {
    data,
    width,
    height,
    changed,
    total: width * height,
    bounds: maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
  };
}

function samePixel(p: Uint8ClampedArray, i: number, q: Uint8ClampedArray, j: number): boolean {
  // Fully transparent pixels look the same whatever their color channels hold.
  if (p[i + 3] === 0 && q[j + 3] === 0) return true;
  return p[i] === q[j] && p[i + 1] === q[j + 1] && p[i + 2] === q[j + 2] && p[i + 3] === q[j + 3];
}
