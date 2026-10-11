import { T } from "../../i18n/differ";
import type { ReactNode } from "react";
import { EXPAND_STEP, type GapRow, type LineRow, type PairRow, type Row, type SplitRow } from "../lib/rows";
import type { Sources } from "../lib/useFileSources";
import type { Side } from "../types";
import { CodeContent } from "./CodeContent";
import { Icon, type IconName } from "./Icons";

export interface Selection {
  side: Side;
  anchor: number;
  head: number;
}

export type ExpandDirection = "up" | "down" | "all";

/** Everything a row needs from the file view. */
export interface RowContext {
  sources: Sources;
  selection: Selection | null;
  /** "side:line" keys covered by a bookmark. */
  marked: Set<string>;
  onPlus(side: Side, line: number): void;
  onEnter(oldNo: number | null, newNo: number | null): void;
  onExpand(gap: GapRow, direction: ExpandDirection): void;
  renderAfter(side: Side, line: number): ReactNode;
}

function inSelection(sel: Selection | null, side: Side, line: number | null): boolean {
  if (!sel || line === null || sel.side !== side) return false;
  return line >= Math.min(sel.anchor, sel.head) && line <= Math.max(sel.anchor, sel.head);
}

function tokensFor(row: LineRow, side: Side, s: Sources) {
  const fromOld = row.oldNo !== null ? s.oldTokens?.[row.oldNo - 1] : undefined;
  const fromNew = row.newNo !== null ? s.newTokens?.[row.newNo - 1] : undefined;
  return (side === "old" ? (fromOld ?? fromNew) : (fromNew ?? fromOld)) ?? null;
}

const SIGN = { add: "+", del: "-", context: " " } as const;

function CodeCell({
  row,
  side,
  ctx,
  className,
  onMouseEnter,
}: {
  row: LineRow;
  side: Side;
  ctx: RowContext;
  className: string;
  onMouseEnter?: () => void;
}) {
  const line = side === "new" ? row.newNo : row.oldNo;
  return (
    <td className={`code ${className}`} onMouseEnter={onMouseEnter}>
      {line !== null && (
        <button
          className="add-bookmark"
          title={T.adicionarMarcadorDica}
          onMouseDown={(e) => {
            e.preventDefault();
            ctx.onPlus(side, line);
          }}
        >
          <Icon name="plus" size={12} />
        </button>
      )}
      <span className="sign">{SIGN[row.kind]}</span>
      {/* Marks the code text (not the sign or buttons) so a text selection maps back to lines. */}
      <span className="code-text" data-side={side} data-line={line ?? undefined}>
        <CodeContent content={row.content} tokens={tokensFor(row, side, ctx.sources)} emph={row.emph} />
      </span>
      {row.noNewline && (
        <span className="no-newline" title={T.semQuebraNoFim}>
          <Icon name="no-entry" size={12} />
        </span>
      )}
    </td>
  );
}

function GapActions({ gap, ctx }: { gap: GapRow; ctx: RowContext }) {
  if (gap.remaining === 0) return null;
  const disabled = ctx.sources.context === null;
  const button = (direction: ExpandDirection, icon: IconName, title: string) => (
    <button
      key={direction}
      className="expand-btn"
      disabled={disabled}
      title={title}
      onClick={() => ctx.onExpand(gap, direction)}
    >
      <Icon name={icon} />
    </button>
  );
  const down = button("down", "expand-down", T.mostrarAbaixo);
  const up = button("up", "expand-up", T.mostrarAcima);

  let buttons: ReactNode;
  if (gap.position === "top") buttons = up;
  else if (gap.position === "bottom") buttons = down;
  else if (gap.remaining !== null && gap.remaining <= EXPAND_STEP)
    buttons = button("all", "unfold", T.mostrarTodas);
  else buttons = [down, up];
  return <div className="gap-buttons">{buttons}</div>;
}

function GapLine({ gap, ctx, split }: { gap: GapRow; ctx: RowContext; split: boolean }) {
  return (
    <tr className="gap">
      <td className="gap-actions" colSpan={split ? 1 : 2}>
        <GapActions gap={gap} ctx={ctx} />
      </td>
      <td className="gap-header" colSpan={split ? 3 : 1}>
        {gap.header}
      </td>
    </tr>
  );
}

export function UnifiedTable({ rows, ctx }: { rows: Row[]; ctx: RowContext }) {
  return (
    <table className="diff unified">
      <colgroup>
        <col className="col-num" />
        <col className="col-num" />
        <col />
      </colgroup>
      <tbody>
        {rows.map((row, i) =>
          row.type === "gap" ? (
            <GapLine key={i} gap={row} ctx={ctx} split={false} />
          ) : (
            <UnifiedLine key={i} row={row} ctx={ctx} />
          ),
        )}
      </tbody>
    </table>
  );
}

function UnifiedLine({ row, ctx }: { row: LineRow; ctx: RowContext }) {
  const side: Side = row.kind === "del" ? "old" : "new";
  const sel = ctx.selection;
  const selected = sel !== null && inSelection(sel, sel.side, sel.side === "new" ? row.newNo : row.oldNo);
  const cls = selected ? `${row.kind} selected` : row.kind;
  const onOld = row.kind !== "add" && row.oldNo !== null;
  const onNew = row.kind !== "del" && row.newNo !== null;
  const marked =
    (onOld && ctx.marked.has(`old:${row.oldNo}`)) || (onNew && ctx.marked.has(`new:${row.newNo}`));
  const oldAfter = onOld ? ctx.renderAfter("old", row.oldNo!) : null;
  const newAfter = onNew ? ctx.renderAfter("new", row.newNo!) : null;

  return (
    <>
      <tr
        className="line"
        data-old={onOld ? row.oldNo! : undefined}
        data-new={onNew ? row.newNo! : undefined}
        onMouseEnter={() => ctx.onEnter(row.oldNo, row.newNo)}
      >
        <td className={`num ${cls}${marked ? " marked" : ""}`}>{row.oldNo}</td>
        <td className={`num ${cls}`}>{row.newNo}</td>
        <CodeCell row={row} side={side} ctx={ctx} className={cls} />
      </tr>
      {(oldAfter || newAfter) && (
        <tr className="annotation">
          <td colSpan={3}>
            {oldAfter}
            {newAfter}
          </td>
        </tr>
      )}
    </>
  );
}

export function SplitTable({ rows, ctx }: { rows: SplitRow[]; ctx: RowContext }) {
  return (
    <table className="diff split">
      <colgroup>
        <col className="col-num" />
        <col />
        <col className="col-num" />
        <col />
      </colgroup>
      <tbody>
        {rows.map((row, i) =>
          row.type === "gap" ? (
            <GapLine key={i} gap={row} ctx={ctx} split />
          ) : (
            <SplitLine key={i} pair={row} ctx={ctx} />
          ),
        )}
      </tbody>
    </table>
  );
}

function SplitLine({ pair, ctx }: { pair: PairRow; ctx: RowContext }) {
  const { left, right } = pair;
  const leftNo = left?.oldNo ?? null;
  const rightNo = right?.newNo ?? null;
  const sideClass = (row: LineRow | null, changed: string, side: Side, line: number | null) => {
    const base = row ? (row.kind === "context" ? "context" : changed) : "empty";
    return inSelection(ctx.selection, side, line) ? `${base} selected` : base;
  };
  const leftCls = sideClass(left, "del", "old", leftNo);
  const rightCls = sideClass(right, "add", "new", rightNo);
  const enterLeft = left ? () => ctx.onEnter(leftNo, null) : undefined;
  const enterRight = right ? () => ctx.onEnter(null, rightNo) : undefined;
  const oldAfter = leftNo !== null ? ctx.renderAfter("old", leftNo) : null;
  const newAfter = rightNo !== null ? ctx.renderAfter("new", rightNo) : null;
  const marked = (side: Side, line: number | null) =>
    line !== null && ctx.marked.has(`${side}:${line}`) ? " marked" : "";

  return (
    <>
      <tr className="line" data-old={leftNo ?? undefined} data-new={rightNo ?? undefined}>
        <td className={`num ${leftCls}${marked("old", leftNo)}`} onMouseEnter={enterLeft}>
          {leftNo}
        </td>
        {left ? (
          <CodeCell row={left} side="old" ctx={ctx} className={leftCls} onMouseEnter={enterLeft} />
        ) : (
          <td className="code empty" />
        )}
        <td className={`num ${rightCls}${marked("new", rightNo)}`} onMouseEnter={enterRight}>
          {rightNo}
        </td>
        {right ? (
          <CodeCell row={right} side="new" ctx={ctx} className={rightCls} onMouseEnter={enterRight} />
        ) : (
          <td className="code empty" />
        )}
      </tr>
      {(oldAfter || newAfter) && (
        <tr className="annotation">
          <td colSpan={2}>{oldAfter}</td>
          <td colSpan={2}>{newAfter}</td>
        </tr>
      )}
    </>
  );
}
