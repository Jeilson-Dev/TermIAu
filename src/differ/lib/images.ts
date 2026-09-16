import { readBlobBytes } from "../api";

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
};

function imageMime(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot > 0 ? (MIME[name.slice(dot + 1)] ?? null) : null;
}

/** Raster images get a visual diff instead of the text/binary view. */
export const isImage = (path: string) => imageMime(path) !== null;

export interface LoadedImage {
  url: string;
  width: number;
  height: number;
  /** Size in bytes. */
  size: number;
  element: HTMLImageElement;
}

// Blob ids are content hashes, so a decoded image never goes stale.
const cache = new Map<string, Promise<LoadedImage>>();

export function loadImage(root: string, oid: string, path: string): Promise<LoadedImage> {
  let image = cache.get(oid);
  if (!image) {
    image = decode(root, oid, imageMime(path) ?? "application/octet-stream");
    image.catch(() => cache.delete(oid));
    cache.set(oid, image);
  }
  return image;
}

async function decode(root: string, oid: string, type: string): Promise<LoadedImage> {
  const bytes = await readBlobBytes(root, oid);
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const element = new Image();
  element.src = url;
  try {
    await element.decode();
  } catch {
    URL.revokeObjectURL(url);
    throw new Error("Não foi possível exibir esta imagem.");
  }
  return { url, width: element.naturalWidth, height: element.naturalHeight, size: bytes.byteLength, element };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
