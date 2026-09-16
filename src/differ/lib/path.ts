export const basename = (path: string) => path.split("/").filter(Boolean).pop() ?? path;
