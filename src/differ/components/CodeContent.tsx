import { memo, useMemo } from "react";
import type { Range } from "../lib/rows";
import { segments, type Token } from "../lib/segments";

interface Props {
  content: string;
  tokens: Token[] | null;
  emph: Range[] | null;
}

export const CodeContent = memo(function CodeContent({ content, tokens, emph }: Props) {
  const parts = useMemo(() => segments(content, tokens, emph), [content, tokens, emph]);
  return (
    <>
      {parts.map((part, i) => {
        const style =
          part.color || part.fontStyle
            ? {
                color: part.color,
                fontStyle: part.fontStyle && part.fontStyle & 1 ? "italic" : undefined,
                fontWeight: part.fontStyle && part.fontStyle & 2 ? 600 : undefined,
              }
            : undefined;
        return (
          <span key={i} className={part.emph ? "emph" : undefined} style={style}>
            {part.content}
          </span>
        );
      })}
    </>
  );
});
