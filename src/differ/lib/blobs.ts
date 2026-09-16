import { readBlob } from "../api";

// Blob ids are content hashes, so a cached blob never goes stale.
const cache = new Map<string, Promise<string[]>>();

export function getBlob(root: string, oid: string): Promise<string[]> {
  let blob = cache.get(oid);
  if (!blob) {
    blob = readBlob(root, oid);
    blob.catch(() => cache.delete(oid));
    cache.set(oid, blob);
  }
  return blob;
}
