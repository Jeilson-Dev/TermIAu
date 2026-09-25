//! Perguntar ao Claude sobre um trecho do diff sem sair da revisão.
//!
//! É o `claude -p` da linha de comando: responde e sai. Nada fica salvo — nem a
//! pergunta rápida nem a que menciona uma sessão, que roda numa cópia dela
//! (`--fork-session`) jogada fora no fim. A sessão mencionada continua como
//! estava, e o `/resume` não se enche de perguntas avulsas.

use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

use super::error::{Error, Result};
use super::git::Repo;

/// O pid de cada pergunta em andamento, pelo id que a webview deu a ela. É o
/// que deixa o botão de cancelar matar o processo certo.
#[derive(Default)]
pub struct Perguntas(pub Mutex<HashMap<String, u32>>);

/// Quantas sessões a lista oferece: as mais recentes são as que interessam.
const SESSOES_MAX: usize = 20;
/// O título vive no fim do arquivo, que chega a vários MB. Basta ler o rabo.
const RABO_BYTES: u64 = 512 * 1024;

const INSTRUCOES: &str = "Você está sendo consultado de dentro de uma ferramenta de revisão de código \
(a aba de diff do TermIAu). O stdin traz o trecho em revisão, o diff do arquivo e, se houver, a conversa \
até aqui. Responda em português, direto ao ponto e curto — a resposta aparece embaixo do trecho, no meio \
do diff.";

const SO_CONVERSA: &str = " Isto é só uma conversa: pode ler o repositório para entender o contexto, mas \
não altere nada — nem que peçam. Se pedirem uma alteração, explique o que faria.";

const COM_ALTERACOES: &str = " O revisor liberou alterações: pode editar os arquivos do repositório quando \
ele pedir. Diga no fim o que alterou.";

/// O que cada modo pode fazer. `--tools` diz quais ferramentas existem, não
/// quais estão liberadas — então as configurações do usuário (um modo auto, um
/// `allow` de Edit) não têm como devolver a escrita a uma pergunta só de
/// conversa. Sem Bash em nenhum dos dois: o diff já vem no contexto.
///
/// E sem `SendMessage`, que é o que mais importa: uma pergunta que menciona a
/// sessão de um orquestrador herda o papel dele. Com a ferramenta à mão, ela já
/// tratou a dúvida do revisor como ordem e despachou "decisão do usuário" para
/// os agentes da equipe — que aplicaram, sem ninguém ter decidido nada.
const FERRAMENTAS_LEITURA: &str = "Read,Grep,Glob";
const FERRAMENTAS_ESCRITA: &str = "Read,Grep,Glob,Edit,Write";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sessao {
    pub id: String,
    pub title: String,
    /// Última escrita no arquivo da sessão, em ms desde a época.
    pub modified: u64,
}

/// O binário do `claude`. O app aberto pelo Finder herda um PATH mínimo, sem o
/// `~/.local/bin` do instalador — então procura nos lugares de sempre e, no
/// fim, pergunta ao shell de login do usuário, que tem o PATH de verdade.
fn binario() -> Result<&'static Path> {
    static BIN: OnceLock<Option<PathBuf>> = OnceLock::new();
    BIN.get_or_init(|| {
        let home = std::env::var("HOME").unwrap_or_default();
        let mut candidatos = vec![
            PathBuf::from(&home).join(".local/bin/claude"),
            PathBuf::from(&home).join(".claude/local/claude"),
            PathBuf::from("/opt/homebrew/bin/claude"),
            PathBuf::from("/usr/local/bin/claude"),
        ];
        if let Some(path) = std::env::var_os("PATH") {
            candidatos.extend(std::env::split_paths(&path).map(|d| d.join("claude")));
        }
        if let Some(achado) = candidatos.into_iter().find(|p| p.is_file()) {
            return Some(achado);
        }
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let saida = Command::new(shell).args(["-lic", "command -v claude"]).output().ok()?;
        String::from_utf8_lossy(&saida.stdout)
            .lines()
            .rev()
            .map(str::trim)
            .find(|l| l.starts_with('/'))
            .map(PathBuf::from)
    })
    .as_deref()
    .ok_or_else(|| Error::Claude("não encontrei o `claude` instalado nesta máquina.".into()))
}

/// Onde o Claude Code guarda as sessões iniciadas nesta pasta: o caminho vira
/// nome de diretório trocando tudo que não é letra ou número por `-`.
fn pasta_sessoes(root: &Path) -> Option<PathBuf> {
    let base = match std::env::var_os("CLAUDE_CONFIG_DIR") {
        Some(dir) => PathBuf::from(dir),
        None => PathBuf::from(std::env::var_os("HOME")?).join(".claude"),
    };
    let nome: String = root
        .to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    Some(base.join("projects").join(nome))
}

/// O título de uma sessão: o que o usuário deu, senão o que o Claude deu, senão
/// o último prompt. `None` para uma sessão sem conversa nenhuma.
fn titulo(arquivo: &Path) -> Option<String> {
    let mut f = std::fs::File::open(arquivo).ok()?;
    let tamanho = f.metadata().ok()?.len();
    f.seek(SeekFrom::Start(tamanho.saturating_sub(RABO_BYTES))).ok()?;
    let mut bytes = Vec::new();
    f.read_to_end(&mut bytes).ok()?;

    let (mut dado, mut gerado, mut prompt) = (None, None, None);
    // A primeira linha pode ter sido cortada no meio; o parse dela só falha.
    for linha in String::from_utf8_lossy(&bytes).lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(linha) else { continue };
        let texto = |campo: &str| v.get(campo).and_then(|t| t.as_str()).map(str::to_owned);
        match v.get("type").and_then(|t| t.as_str()) {
            Some("custom-title") => dado = texto("customTitle").or(dado),
            Some("ai-title") => gerado = texto("aiTitle").or(gerado),
            Some("last-prompt") => prompt = texto("lastPrompt").or(prompt),
            _ => {}
        }
    }
    let t = dado.or(gerado).or(prompt)?;
    let t = t.lines().next().unwrap_or_default().trim();
    Some(if t.chars().count() > 90 { format!("{}…", t.chars().take(90).collect::<String>()) } else { t.to_owned() })
}

/// As sessões do Claude Code abertas na raiz deste repositório, da mais recente
/// para a mais antiga.
pub fn sessoes(root: &Path) -> Result<Vec<Sessao>> {
    let Some(pasta) = pasta_sessoes(root) else { return Ok(Vec::new()) };
    let Ok(entradas) = std::fs::read_dir(&pasta) else { return Ok(Vec::new()) };

    let mut arquivos: Vec<(PathBuf, u64)> = entradas
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
        .filter_map(|p| {
            let quando = p.metadata().ok()?.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
            Some((p, quando.as_millis() as u64))
        })
        .collect();
    arquivos.sort_by(|a, b| b.1.cmp(&a.1));

    Ok(arquivos
        .into_iter()
        .filter_map(|(p, modified)| {
            let title = titulo(&p)?;
            let id = p.file_stem()?.to_string_lossy().into_owned();
            Some(Sessao { id, title, modified })
        })
        .take(SESSOES_MAX)
        .collect())
}

/// Um arquivo que o Claude mexeu numa pergunta com alterações liberadas: como
/// estava e como ficou. `None` é "não existia" (antes) ou "apagado" (depois).
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Alteracao {
    pub path: String,
    pub before: Option<String>,
    pub after: Option<String>,
    /// Dá para voltar ao `before` com segurança. Não dá quando não se sabe como
    /// o arquivo estava (ignorado pelo git, grande demais) ou quando é binário.
    pub undoable: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Resposta {
    pub answer: String,
    pub changes: Vec<Alteracao>,
}

/// Arquivo não rastreado maior que isto não entra na foto: desfazer a edição
/// dele fica indisponível, em vez de a foto custar memória à toa.
const FOTO_MAX_ARQUIVO: u64 = 1024 * 1024;
const FOTO_MAX_TOTAL: u64 = 32 * 1024 * 1024;

/// Como a árvore de trabalho estava antes da pergunta. Os rastreados cabem num
/// commit solto do `git stash create` — que não mexe em ref, índice nem disco —
/// e os não rastreados, que ele não pega, vão copiados.
struct Foto {
    base: Option<String>,
    nao_rastreados: HashSet<String>,
    copias: HashMap<String, Vec<u8>>,
}

fn fotografar(repo: &Repo) -> Foto {
    let base = repo
        .run_string(&["stash", "create"])
        .ok()
        .filter(|sha| !sha.is_empty())
        .or_else(|| repo.resolve_commit("HEAD"));
    let lista = repo.run(&["ls-files", "--others", "--exclude-standard", "-z"]).unwrap_or_default();
    let nao_rastreados: HashSet<String> = lista
        .split(|b| *b == 0)
        .filter(|n| !n.is_empty())
        .map(|n| String::from_utf8_lossy(n).into_owned())
        .collect();
    let mut copias = HashMap::new();
    let mut total = 0;
    for nome in &nao_rastreados {
        let caminho = repo.root().join(nome);
        let Ok(meta) = caminho.metadata() else { continue };
        if meta.len() > FOTO_MAX_ARQUIVO || total + meta.len() > FOTO_MAX_TOTAL {
            continue;
        }
        if let Ok(bytes) = std::fs::read(&caminho) {
            total += meta.len();
            copias.insert(nome.clone(), bytes);
        }
    }
    Foto { base, nao_rastreados, copias }
}

enum Antes {
    Conteudo(Vec<u8>),
    NaoExistia,
    Desconhecido,
}

impl Foto {
    fn antes(&self, repo: &Repo, nome: &str) -> Antes {
        if self.nao_rastreados.contains(nome) {
            return self.copias.get(nome).map_or(Antes::Desconhecido, |b| Antes::Conteudo(b.clone()));
        }
        if let Some(base) = &self.base {
            if let Ok(bytes) = repo.run(&["show", &format!("{base}:{nome}")]) {
                return Antes::Conteudo(bytes);
            }
        }
        // Nem rastreado nem novo: ou não existia, ou o git ignora — e aí não há foto.
        let ignorado = repo.run(&["check-ignore", "-q", "--", nome]).is_ok();
        if ignorado { Antes::Desconhecido } else { Antes::NaoExistia }
    }
}

/// O caminho que o Claude usou, relativo à raiz. Ele escreve caminhos absolutos,
/// e às vezes pelo outro lado de um link (`/tmp` e `/private/tmp`, no macOS).
fn relativo(raiz: &Path, caminho: &str) -> Option<String> {
    let p = Path::new(caminho);
    let p = if p.is_absolute() { p.to_path_buf() } else { raiz.join(p) };
    if let Ok(r) = p.strip_prefix(raiz) {
        return Some(r.to_string_lossy().into_owned());
    }
    let raiz = raiz.canonicalize().ok()?;
    let real = match p.canonicalize() {
        Ok(real) => real,
        Err(_) => p.parent()?.canonicalize().ok()?.join(p.file_name()?),
    };
    real.strip_prefix(&raiz).ok().map(|r| r.to_string_lossy().into_owned())
}

/// Os arquivos em que o Claude usou uma ferramenta de escrita, na ordem.
fn editados(linhas: &[serde_json::Value]) -> Vec<String> {
    let mut vistos = Vec::new();
    for v in linhas {
        if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
            continue;
        }
        let Some(partes) = v.pointer("/message/content").and_then(|c| c.as_array()) else { continue };
        for parte in partes {
            if parte.get("type").and_then(|t| t.as_str()) != Some("tool_use") {
                continue;
            }
            if !matches!(parte.get("name").and_then(|n| n.as_str()), Some("Edit" | "Write" | "MultiEdit" | "NotebookEdit")) {
                continue;
            }
            let entrada = parte.get("input");
            let caminho = entrada
                .and_then(|i| i.get("file_path").or_else(|| i.get("notebook_path")))
                .and_then(|c| c.as_str());
            if let Some(c) = caminho {
                if !vistos.iter().any(|v| v == c) {
                    vistos.push(c.to_owned());
                }
            }
        }
    }
    vistos
}

fn alteracao(repo: &Repo, foto: &Foto, nome: String) -> Alteracao {
    let depois = std::fs::read(repo.root().join(&nome)).ok();
    let (antes, conhecido) = match foto.antes(repo, &nome) {
        Antes::Conteudo(b) => (Some(b), true),
        Antes::NaoExistia => (None, true),
        Antes::Desconhecido => (None, false),
    };
    // Binário não se mostra nem se desfaz daqui: fica só o nome, para saber que mexeu.
    let texto = |b: Option<Vec<u8>>| b.map(String::from_utf8).transpose();
    match (texto(antes), texto(depois)) {
        (Ok(before), Ok(after)) => Alteracao { path: nome, before, after, undoable: conhecido },
        _ => Alteracao { path: nome, before: None, after: None, undoable: false },
    }
}

/// Roda a pergunta e devolve a resposta — e, com alterações liberadas, o que
/// mudou em cada arquivo mexido, para o revisor ver e poder desfazer. `contexto`
/// vai pelo stdin: é o trecho, o diff e a conversa até aqui.
#[allow(clippy::too_many_arguments)]
pub fn perguntar(
    root: &Path,
    pids: &Perguntas,
    id: &str,
    pergunta: &str,
    contexto: &str,
    modelo: Option<&str>,
    sessao: Option<&str>,
    alterar: bool,
) -> Result<Resposta> {
    let (ferramentas, modo, regra) = if alterar {
        (FERRAMENTAS_ESCRITA, "acceptEdits", COM_ALTERACOES)
    } else {
        // `dontAsk` nega o que não foi liberado, em vez de ficar esperando alguém responder.
        (FERRAMENTAS_LEITURA, "dontAsk", SO_CONVERSA)
    };
    let repo = Repo::open(root)?;
    let foto = alterar.then(|| fotografar(&repo));

    let mut cmd = Command::new(binario()?);
    cmd.current_dir(root)
        // `stream-json` em vez de `json`: é nele que aparecem as ferramentas usadas,
        // e é por elas que se sabe quais arquivos foram mexidos.
        .args(["-p", pergunta, "--output-format", "stream-json", "--verbose", "--no-session-persistence"])
        .args(["--append-system-prompt", &format!("{INSTRUCOES}{regra}")])
        .args(["--tools", ferramentas, "--permission-mode", modo])
        // Os servidores MCP do usuário trazem ferramentas de escrita próprias (criar ticket, mandar mensagem).
        .arg("--strict-mcp-config")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(m) = modelo.filter(|m| !m.is_empty()) {
        cmd.args(["--model", m]);
    }
    if let Some(s) = sessao.filter(|s| !s.is_empty()) {
        cmd.args(["--resume", s, "--fork-session"]);
    }

    let mut filho = cmd.spawn().map_err(|err| Error::Claude(format!("não deu para rodar o `claude`: {err}")))?;
    pids.0.lock().unwrap().insert(id.to_owned(), filho.id());

    // Numa thread à parte: um contexto grande enche o pipe antes de o claude
    // começar a ler, e escrever tudo daqui travaria esperando a saída.
    let mut entrada = filho.stdin.take();
    let contexto = contexto.to_owned();
    std::thread::spawn(move || {
        if let Some(e) = entrada.as_mut() {
            let _ = e.write_all(contexto.as_bytes());
        }
    });

    let saida = filho.wait_with_output();
    let cancelada = pids.0.lock().unwrap().remove(id).is_none();
    let saida = saida?;

    let linhas: Vec<serde_json::Value> = String::from_utf8_lossy(&saida.stdout)
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    // Cancelada ou com erro, a pergunta pode ter editado arquivos antes de parar.
    // Aí o que mudou não pode se perder no erro: volta como resposta, com o aviso.
    let changes = match &foto {
        Some(foto) => editados(&linhas)
            .iter()
            .filter_map(|c| relativo(repo.root(), c))
            .map(|nome| alteracao(&repo, foto, nome))
            .collect(),
        None => Vec::new(),
    };
    let fim = linhas.iter().rev().find(|v| v.get("type").and_then(|t| t.as_str()) == Some("result"));
    let texto = fim.and_then(|v| v.get("result")).and_then(|r| r.as_str()).unwrap_or_default().to_owned();
    let falhou = fim.and_then(|v| v.get("is_error")).and_then(|e| e.as_bool()).unwrap_or(true);

    if cancelada || fim.is_none() || falhou {
        let motivo = if cancelada {
            "pergunta cancelada.".to_owned()
        } else if fim.is_some() {
            texto
        } else {
            let erro = String::from_utf8_lossy(&saida.stderr).trim().to_owned();
            if erro.is_empty() { format!("o `claude` saiu com {}", saida.status) } else { erro }
        };
        if changes.is_empty() {
            return Err(Error::Claude(motivo));
        }
        return Ok(Resposta { answer: format!("⚠︎ {motivo}"), changes });
    }
    Ok(Resposta { answer: texto, changes })
}

/// Volta os arquivos ao que eram antes da pergunta. Só mexe no arquivo que
/// continua exatamente como o Claude deixou: se alguém o editou depois, desfazer
/// apagaria esse trabalho — ele fica, e volta na lista do que não deu.
pub fn desfazer(root: &Path, alteracoes: &[Alteracao]) -> Result<Vec<String>> {
    let repo = Repo::open(root)?;
    let raiz = repo.root().canonicalize()?;
    let mut ficaram = Vec::new();
    for a in alteracoes.iter().filter(|a| a.undoable) {
        let caminho = repo.root().join(&a.path);
        let dentro = match caminho.parent().and_then(|p| p.canonicalize().ok()) {
            Some(pai) => pai.starts_with(&raiz),
            None => false,
        };
        let agora = std::fs::read(&caminho).ok().map(|b| String::from_utf8_lossy(&b).into_owned());
        if !dentro || agora != a.after {
            ficaram.push(a.path.clone());
            continue;
        }
        let feito = match &a.before {
            Some(conteudo) => std::fs::write(&caminho, conteudo),
            None => std::fs::remove_file(&caminho),
        };
        if feito.is_err() {
            ficaram.push(a.path.clone());
        }
    }
    Ok(ficaram)
}

/// Mata a pergunta em andamento. Tirar o pid do mapa antes é o que avisa a
/// `perguntar` que a saída vazia foi cancelamento, não falha.
pub fn cancelar(pids: &Perguntas, id: &str) {
    if let Some(pid) = pids.0.lock().unwrap().remove(id) {
        unsafe {
            libc::kill(pid as libc::pid_t, libc::SIGTERM);
        }
    }
}
