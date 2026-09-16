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
        <div className="segmented" role="group" aria-label="Escopo da revisão">
          <button
            className={scope === "branch" ? "active" : ""}
            title="Tudo o que a branch mudou desde que saiu da branch alvo"
            onClick={() => props.onScope("branch")}
          >
            <Icon name="git-branch" size={14} />
            Branch inteira
          </button>
          <button
            className={scope === "incremental" ? "active" : ""}
            title="Só o que mudou desde o último commit com todos os arquivos revisados"
            onClick={() => props.onScope("incremental")}
          >
            <Icon name="history" size={14} />
            Incremental
          </button>
        </div>
      )}
      {repo && (
        <div className="compare">
          {sinceBase ? (
            <span
              className="base-pill"
              title={`Última revisão completa: ${sinceBase}\nO diff mostra só o que mudou depois dela`}
            >
              <Icon name="check" size={14} />
              {sinceBase.slice(0, 7)}
            </span>
          ) : (
            <select
              className="branch-select"
              aria-label="Branch alvo"
              title="Branch alvo da comparação"
              value={target}
              onChange={(e) => props.onTargetChange(e.target.value)}
            >
              {target && !knownTarget && <option>{target}</option>}
              <optgroup label="Locais">
                {repo.localBranches.map((b) => (
                  <option key={b}>{b}</option>
                ))}
              </optgroup>
              {repo.remoteBranches.length > 0 && (
                <optgroup label="Remotas">
                  {repo.remoteBranches.map((b) => (
                    <option key={b}>{b}</option>
                  ))}
                </optgroup>
              )}
            </select>
          )}
          <Icon name="arrow-left" className="compare-arrow" />
          <span className="branch-pill" title="Branch em revisão (a que está ativa na pasta)">
            <Icon name="git-branch" size={14} />
            {repo.currentBranch ?? "HEAD destacado"}
          </span>
        </div>
      )}
      {diff && (
        <span className="toolbar-stats">
          {fileCount} {fileCount === 1 ? "arquivo" : "arquivos"} <span className="add">+{diff.additions}</span>{" "}
          <span className="del">−{diff.deletions}</span>
        </span>
      )}
      <span className="spacer" />
      {diff && fileCount > 0 && <ReviewProgress viewed={props.viewedCount} total={fileCount} />}
      {/* Sem botão de atualizar: o diff avisa sozinho quando o repositório
          mexe. Sobrou só o sinal de que ele está sendo refeito — recarregar sem
          nada piscando parece que nada aconteceu. */}
      {props.loading && (
        <span className="recarregando">
          <Icon name="refresh" size={14} className="spin" />
          Atualizando…
        </span>
      )}
      {repo && (
        <div className="segmented" role="group" aria-label="Modo de visualização">
          <button
            className={props.viewMode === "unified" ? "active" : ""}
            onClick={() => props.onViewMode("unified")}
          >
            <Icon name="unified" size={14} />
            Unificado
          </button>
          <button
            className={props.viewMode === "split" ? "active" : ""}
            onClick={() => props.onViewMode("split")}
          >
            <Icon name="split" size={14} />
            Lado a lado
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
      title="Com todos revisados, a revisão deste commit fica completa: o Incremental passa a partir dele no próximo commit"
    >
      <span>
        {viewed} de {total} revisados
      </span>
      <div className="progress-bar">
        <div style={{ width: `${(viewed / total) * 100}%` }} />
      </div>
    </div>
  );
}
