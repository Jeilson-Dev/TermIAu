import type { FileDiff, StagedState } from "../types";

export interface DirNode {
  type: "dir";
  name: string;
  path: string;
  children: TreeNode[];
}

export interface FileNode {
  type: "file";
  name: string;
  file: FileDiff;
}

export type TreeNode = DirNode | FileNode;

/** Folders first, then files; chains of single-folder directories collapse into "a/b/c". */
export function buildTree(files: FileDiff[]): TreeNode[] {
  const root: DirNode = { type: "dir", name: "", path: "", children: [] };
  for (const file of files) {
    const parts = file.path.split("/");
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      let next = dir.children.find((c): c is DirNode => c.type === "dir" && c.name === part);
      if (!next) {
        next = { type: "dir", name: part, path: dir.path ? `${dir.path}/${part}` : part, children: [] };
        dir.children.push(next);
      }
      dir = next;
    }
    dir.children.push({ type: "file", name: parts[parts.length - 1], file });
  }
  return normalize(root.children);
}

function normalize(nodes: TreeNode[]): TreeNode[] {
  return nodes
    .map((node): TreeNode => {
      if (node.type === "file") return node;
      let dir = node;
      while (dir.children.length === 1 && dir.children[0].type === "dir") {
        const child: DirNode = dir.children[0];
        dir = { ...child, name: `${dir.name}/${child.name}` };
      }
      return { ...dir, children: normalize(dir.children) };
    })
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

/** Files in tree order, which is also the order they're listed in the diff. */
export function flattenTree(nodes: TreeNode[]): FileDiff[] {
  return nodes.flatMap((node) => (node.type === "file" ? [node.file] : flattenTree(node.children)));
}

/**
 * How the folder stands in the index, looking at what is inside it: all there, nothing there or
 * part of it. It decides which buttons the folder's row shows.
 */
export function dirStaged(node: DirNode): StagedState | null {
  const estados = flattenTree(node.children).map((f) => f.staged);
  if (estados.length === 0 || estados.some((e) => !e)) return null;
  if (estados.every((e) => e === "staged")) return "staged";
  if (estados.every((e) => e === "unstaged")) return "unstaged";
  return "partial";
}

export function filterTree(nodes: TreeNode[], query: string): TreeNode[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return nodes;
  return nodes.flatMap((node): TreeNode[] => {
    if (node.type === "file") return node.file.path.toLowerCase().includes(needle) ? [node] : [];
    const children = filterTree(node.children, needle);
    return children.length ? [{ ...node, children }] : [];
  });
}
