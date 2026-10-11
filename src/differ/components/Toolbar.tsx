import { T } from "../../i18n/differ";
import type { RepoInfo, ReviewDiff, Scope, ViewMode } from "../types";
import { Icon } from "./Icons";

interface Props {
  repo: RepoInfo | null;
  target: string;
  diff: ReviewDiff | null;
  loading: boolean;
  viewedCount: number;
  viewMode: ViewMode;
  scope: Scope;
  /** Last commit reviewed to the end, when the incremental review starts from it. */
  sinceBase: string | null;
  onTargetChange(target: string): void;
  onViewMode(mode: ViewMode): void;
  onScope(scope: Scope): void;
}

export function Toolbar(props: Props) {
  const { repo, diff, target, scope, sinceBase } = props;
  const knownTarget = repo && [...repo.localBranches, ...repo.remoteBranches].includes(target);
  const fileCount = diff?.files.length ?? 0;

  return (
    <header className="toolbar">
      <span className="repo-nome" title={repo?.root}>
        <Icon name="folder" />
        {repo?.name ?? "Diff"}
      </span>
      {repo && (
        <div className="segmented" role="group" aria-label={T.escopoDaRevisao}>
          <button
            className={scope === "branch" ? "active" : ""}
            title={T.escopoBranchDica}
            onClick={() => props.onScope("branch")}
          >
            <Icon name="git-branch" size={14} />
            {T.escopoBranch}
          </button>
          <button
            className={scope === "incremental" ? "active" : ""}
            title={T.escopoIncrementalDica}
            onClick={() => props.onScope("incremental")}
          >
            <Icon name="history" size={14} />
            {T.escopoIncremental}
          </button>
          <button
            className={scope === "working" ? "active" : ""}
            title={T.escopoWorkingDica}
            onClick={() => props.onScope("working")}
          >
            <Icon name="pencil" size={14} />
            {T.escopoWorking}
          </button>
        </div>
      )}
      {repo && (
        <div className="compare">
          {scope === "working" ? (
            <span className="base-pill" title={T.baseHeadDica}>
              <Icon name="git-commit" size={14} />
              HEAD
            </span>
          ) : sinceBase ? (
            <span
              className="base-pill"
              title={T.baseRevisaoDica(sinceBase)}
            >
              <Icon name="check" size={14} />
              {sinceBase.slice(0, 7)}
            </span>
          ) : (
            <select
              className="branch-select"
              aria-label={T.branchAlvo}
              title={T.branchAlvoDica}
              value={target}
              onChange={(e) => props.onTargetChange(e.target.value)}
            >
              {target && !knownTarget && <option>{target}</option>}
              <optgroup label={T.branchesLocais}>
                {repo.localBranches.map((b) => (
                  <option key={b}>{b}</option>
                ))}
              </optgroup>
              {repo.remoteBranches.length > 0 && (
                <optgroup label={T.branchesRemotas}>
                  {repo.remoteBranches.map((b) => (
                    <option key={b}>{b}</option>
                  ))}
                </optgroup>
              )}
            </select>
          )}
          <Icon name="arrow-left" className="compare-arrow" />
          <span className="branch-pill" title={T.branchEmRevisaoDica}>
            <Icon name="git-branch" size={14} />
            {repo.currentBranch ?? T.headDestacado}
          </span>
        </div>
      )}
      {diff && (
        <span className="toolbar-stats">
          {T.arquivos(fileCount)} <span className="add">+{diff.additions}</span>{" "}
          <span className="del">−{diff.deletions}</span>
        </span>
      )}
      <span className="spacer" />
      {diff && fileCount > 0 && <ReviewProgress viewed={props.viewedCount} total={fileCount} />}
      {/* No refresh button: the diff notices on its own when the repository
          changes. All that's left is the sign that it is being redone — reloading with
          nothing flashing looks like nothing happened. */}
      {props.loading && (
        <span className="recarregando">
          <Icon name="refresh" size={14} className="spin" />
          {T.atualizando}
        </span>
      )}
      {repo && (
        <div className="segmented" role="group" aria-label={T.modoDeVisualizacao}>
          <button
            className={props.viewMode === "unified" ? "active" : ""}
            onClick={() => props.onViewMode("unified")}
          >
            <Icon name="unified" size={14} />
            {T.unificado}
          </button>
          <button
            className={props.viewMode === "split" ? "active" : ""}
            onClick={() => props.onViewMode("split")}
          >
            <Icon name="split" size={14} />
            {T.ladoALado}
          </button>
        </div>
      )}
    </header>
  );
}

function ReviewProgress({ viewed, total }: { viewed: number; total: number }) {
  return (
    <div
      className={viewed === total ? "progress done" : "progress"}
      title={T.progressoDica}
    >
      <span>{T.revisados(viewed, total)}</span>
      <div className="progress-bar">
        <div style={{ width: `${(viewed / total) * 100}%` }} />
      </div>
    </div>
  );
}
