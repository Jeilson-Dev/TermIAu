mod area;
mod differ;
mod escuta;
mod idioma;

use std::collections::HashMap;
use std::io::{Read, Write};
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine;
use idioma::tr;
use portable_pty::{Child, ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use tauri::menu::{AboutMetadata, CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, State};

/// Tudo que precisamos guardar de uma sessão de PTY viva — uma por aba.
struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// Pid do shell. Comparado ao grupo em primeiro plano do terminal, diz se há
    /// um programa rodando na frente dele (ver `pty_ocupado`).
    pid: Option<u32>,
    /// Marcado antes de matarmos o shell de propósito (aba fechada, reload da
    /// webview). A thread de espera consulta isto para não anunciar "encerrado"
    /// de uma aba que o próprio usuário já mandou embora.
    closing: Arc<AtomicBool>,
    /// Guardados no spawn e retirados no attach. As threads que consomem os dois
    /// só começam quando a aba avisa que já está ouvindo os eventos dela — ver
    /// `pty_attach`. Enquanto isso a saída do shell espera no buffer do PTY.
    reader: Option<Box<dyn Read + Send>>,
    child: Option<Box<dyn Child + Send + Sync>>,
}

#[derive(Default)]
struct Ptys {
    sessions: Mutex<HashMap<u64, Session>>,
    /// Ids nascem aqui, não no JS: um reload da webview zeraria o contador de lá
    /// e a aba nova colidiria com a sessão órfã de mesmo número.
    next_id: AtomicU64,
}

/// O que é resolvido uma vez no boot e vale para a execução inteira.
struct Config {
    socket: PathBuf,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            // O pid no nome deixa duas janelas do TermIAu conviverem sem se
            // roubarem eventos; o hook descobre o caminho pelo ambiente do painel.
            socket: std::env::temp_dir().join(format!("termiau-{}.sock", std::process::id())),
        }
    }
}

/// Erros da webview são invisíveis no terminal sem esta ponte.
#[tauri::command]
fn js_log(msg: String) {
    eprintln!("[termiau] erro na webview: {msg}");
}

/// Variáveis que uma sessão de shell legitimamente precisa herdar do sistema.
/// Tudo o mais é lixo de quem lançou o app (npm, cargo, o terminal-pai) e não
/// tem por que aparecer aqui dentro: o login shell reconstrói PATH, FPATH etc.
const HERDA: &[&str] = &[
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "SSH_AUTH_SOCK",              // sem isto, git/ssh com agente para de funcionar
    "__CF_USER_TEXT_ENCODING",    // codificação de texto do macOS
];

fn shell(cwd: Option<String>, id: u64, cfg: &Config) -> CommandBuilder {
    let sh = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut cmd = CommandBuilder::new(sh);
    cmd.arg("-l"); // login shell: carrega o PATH completo do usuário

    // Começa de zero: senão o shell herda o ambiente de quem abriu o app
    // (npm_*, CARGO_*, ITERM_SESSION_ID...) e se comporta como se fosse aquele contexto.
    cmd.env_clear();
    for k in HERDA {
        if let Ok(v) = std::env::var(k) {
            cmd.env(k, v);
        }
    }

    // PATH mínimo de bootstrap; /etc/zprofile + .zshrc montam o resto.
    // O `termiau` vai no fim: o /etc/zprofile põe os do sistema na frente e
    // mantém os que já estavam, então ele continua achável sem passar na frente
    // de nada seu.
    let mut path = String::from("/usr/bin:/bin:/usr/sbin:/sbin");
    if let Some(bin) = dir_cli() {
        path = format!("{path}:{}", bin.display());
    }
    cmd.env("PATH", path);

    // Aba nova herda o diretório da aba de origem, como no iTerm2. Um cwd que
    // não existe mais (pasta apagada) faria o spawn falhar: cai pro HOME.
    let dir = cwd
        .filter(|p| std::path::Path::new(p).is_dir())
        .or_else(dirs_home);
    if let Some(dir) = dir {
        cmd.cwd(dir);
    }

    // Sem isto, aplicações TUI não sabem que podem usar cor.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "TermIAu");

    // Como o hook do Claude Code sabe pra quem está falando. Ele roda como neto
    // deste shell, então herda os dois — e fora do TermIAu não existem, que é o
    // que faz o mesmo hook ficar calado em outro terminal.
    cmd.env("TERMIAU_PAINEL", id.to_string());
    cmd.env("TERMIAU_SOCK", &cfg.socket);
    cmd
}

fn dirs_home() -> Option<String> {
    std::env::var("HOME").ok()
}

/// Abre um shell novo e devolve o id da sessão. Os eventos dela saem em
/// `pty://data/<id>` e `pty://exit/<id>`, para cada aba ouvir só o que é seu.
/// O shell já começa a rodar aqui, mas ninguém lê a saída dele até `pty_attach`.
#[tauri::command]
fn pty_spawn(
    state: State<'_, Ptys>,
    cfg: State<'_, Config>,
    rows: u16,
    cols: u16,
    cwd: Option<String>,
) -> Result<u64, String> {
    let id = state.next_id.fetch_add(1, Ordering::SeqCst);

    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let child = pair.slave.spawn_command(shell(cwd, id, &cfg)).map_err(|e| e.to_string())?;
    let killer = child.clone_killer();
    let pid = child.process_id();
    drop(pair.slave); // solta o lado escravo, senão nunca vemos o EOF

    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    state.sessions.lock().unwrap().insert(
        id,
        Session {
            master: pair.master,
            writer,
            killer,
            pid,
            closing: Arc::new(AtomicBool::new(false)),
            reader: Some(reader),
            child: Some(child),
        },
    );

    Ok(id)
}

/// Liga as threads que bombeiam a sessão. Separado do spawn de propósito: um
/// evento emitido antes de a aba chamar `listen` seria descartado, e o que se
/// perderia é justamente o começo do prompt.
#[tauri::command]
fn pty_attach(app: AppHandle, state: State<'_, Ptys>, id: u64) -> Result<(), String> {
    let (mut reader, mut child, closing) = {
        let mut sessions = state.sessions.lock().unwrap();
        let s = sessions.get_mut(&id).ok_or("pty não iniciado")?;
        let reader = s.reader.take().ok_or("pty já ligado")?;
        let child = s.child.take().ok_or("pty já ligado")?;
        (reader, child, s.closing.clone())
    };

    // Thread de leitura: bombeia a saída do shell pra janela.
    let reader_app = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Err(e) => { eprintln!("[termiau] erro de leitura no pty {id}: {e}"); break }
                Ok(n) => {
                    // base64 porque um chunk pode cortar um caractere UTF-8 ao meio.
                    let payload = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    let _ = reader_app.emit(&format!("pty://data/{id}"), payload);
                }
            }
        }
    });

    // Thread de espera: avisa a UI quando o shell morrer sozinho (`exit`, crash).
    std::thread::spawn(move || {
        let code = child.wait().ok().map(|s| s.exit_code());
        if !closing.load(Ordering::SeqCst) {
            let _ = app.emit(&format!("pty://exit/{id}"), code);
        }
    });

    Ok(())
}

/// Um link do terminal ou do chat, no navegador padrão. Dentro do WebView o
/// `window.open` não vai a lugar nenhum.
#[tauri::command]
fn abrir_link(url: String) -> Result<(), String> {
    if !["http://", "https://", "mailto:"].iter().any(|p| url.starts_with(p)) {
        return Err(format!("link não suportado: {url}"));
    }
    std::process::Command::new("/usr/bin/open").arg(&url).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn pty_write(state: State<'_, Ptys>, id: u64, data: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    let s = sessions.get_mut(&id).ok_or("pty não iniciado")?;
    s.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    s.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
fn pty_resize(state: State<'_, Ptys>, id: u64, rows: u16, cols: u16) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    let s = sessions.get(&id).ok_or("pty não iniciado")?;
    s.master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

/// Diretório de trabalho atual da sessão — o que a aba nova vai herdar.
/// No macOS o kernel responde isso pelo pid do processo em primeiro plano do PTY.
#[tauri::command]
fn pty_cwd(state: State<'_, Ptys>, id: u64) -> Option<String> {
    let sessions = state.sessions.lock().unwrap();
    let s = sessions.get(&id)?;
    let pid = s.master.process_group_leader()?;
    cwd_do_processo(pid)
}

#[cfg(target_os = "macos")]
fn cwd_do_processo(pid: i32) -> Option<String> {
    // `lsof -a -d cwd` é o caminho sem dependência nova; o -F sai em campos
    // prefixados por letra, e o do cwd é `n`.
    let out = std::process::Command::new("/usr/sbin/lsof")
        .args(["-a", "-d", "cwd", "-p", &pid.to_string(), "-Fn"])
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .find_map(|l| l.strip_prefix('n').map(str::to_string))
}

#[cfg(not(target_os = "macos"))]
fn cwd_do_processo(pid: i32) -> Option<String> {
    std::fs::read_link(format!("/proc/{pid}/cwd"))
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
}

/// Fecha uma aba: mata o shell dela e esquece a sessão.
#[tauri::command]
fn pty_close(state: State<'_, Ptys>, id: u64) {
    if let Some(mut s) = state.sessions.lock().unwrap().remove(&id) {
        s.closing.store(true, Ordering::SeqCst);
        let _ = s.killer.kill();
    }
}

/// Toda recarga da webview começa do zero: sem isto os shells das abas
/// anteriores continuariam vivos, sem nenhuma aba apontando pra eles.
#[tauri::command]
fn pty_close_all(state: State<'_, Ptys>) {
    for (_, mut s) in state.sessions.lock().unwrap().drain() {
        s.closing.store(true, Ordering::SeqCst);
        let _ = s.killer.kill();
    }
}

/// Há um programa na frente do shell — o app que o play mandou rodar, um `vim`.
/// O terminal tem um grupo de processos em primeiro plano; quando ele é o próprio
/// shell, o comando digitado já terminou.
#[tauri::command]
fn pty_ocupado(state: State<'_, Ptys>, id: u64) -> bool {
    let sessions = state.sessions.lock().unwrap();
    let Some(s) = sessions.get(&id) else { return false };
    match (s.master.process_group_leader(), s.pid) {
        (Some(frente), Some(shell)) => frente as u32 != shell,
        _ => false,
    }
}

/// Manda um sinal ao programa em primeiro plano. Vai para o grupo inteiro, como
/// o Ctrl+C: os filhos que ele abriu (um servidor, o processo do emulador) saem
/// junto em vez de ficarem órfãos. O shell nunca recebe — fechar o painel é outra
/// conversa, e é do `pty_close`.
#[tauri::command]
fn pty_sinal(state: State<'_, Ptys>, id: u64, sinal: i32) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    let s = sessions.get(&id).ok_or("pty não iniciado")?;
    let frente = s.master.process_group_leader().ok_or("sem processo em primeiro plano")?;
    if Some(frente as u32) == s.pid {
        return Ok(());
    }
    if unsafe { libc::kill(-frente, sinal) } != 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(())
}

/// O `.vscode/launch.json` do projeto de um painel, com o `tasks.json` ao lado.
#[derive(serde::Serialize)]
struct Launch {
    /// A pasta que tem o `.vscode`: é o `${workspaceFolder}` das configurações.
    pasta: String,
    home: String,
    launch: String,
    tasks: Option<String>,
}

/// O mais próximo subindo a partir do diretório do painel: um painel numa
/// subpasta do projeto ainda roda o launch.json da raiz, como no VS Code aberto
/// na raiz do repositório.
#[tauri::command]
fn launch_ler(cwd: String) -> Option<Launch> {
    std::path::Path::new(&cwd).ancestors().find_map(|dir| {
        let vscode = dir.join(".vscode");
        let launch = std::fs::read_to_string(vscode.join("launch.json")).ok()?;
        Some(Launch {
            pasta: dir.display().to_string(),
            home: dirs_home().unwrap_or_default(),
            launch,
            tasks: std::fs::read_to_string(vscode.join("tasks.json")).ok(),
        })
    })
}

/// Um projeto Dart é Flutter quando o pubspec depende do SDK do Flutter — é o
/// que decide entre `flutter run` e `dart run`, como a extensão do Dart decide.
#[tauri::command]
fn projeto_flutter(pasta: String) -> bool {
    std::fs::read_to_string(std::path::Path::new(&pasta).join("pubspec.yaml"))
        .map(|pubspec| pubspec.contains("sdk: flutter"))
        .unwrap_or(false)
}

/// Um pedaço do transcript de uma sessão do Claude Code.
#[derive(serde::Serialize)]
struct Trecho {
    texto: String,
    /// Até onde este pedaço foi, em bytes: é o `desde` da próxima leitura.
    fim: u64,
    /// O começo ficou de fora (arquivo grande demais), ou o arquivo encolheu e a
    /// leitura recomeçou: o que a tela já mostrava não vale mais.
    do_zero: bool,
    cortado: bool,
}

/// O transcript inteiro de uma sessão longa passa de dezenas de MB, quase tudo
/// resultado de ferramenta. A conversa que interessa é o fim dele.
const TRANSCRICAO_TETO: u64 = 6 * 1024 * 1024;

/// O que o transcript ganhou desde `desde`. Só linhas inteiras: a última, se o
/// Claude ainda a está escrevendo, fica para a próxima leitura.
///
/// O caminho vem do hook, mas quem o entrega é a webview — então só vale um
/// `.jsonl` de dentro de `~/.claude`, e não qualquer arquivo do disco.
#[tauri::command]
fn transcricao_ler(caminho: String, desde: u64) -> Result<Trecho, String> {
    use std::io::{Seek, SeekFrom};

    let base = dir_claude().ok_or("sem pasta do Claude Code")?;
    let base = base.canonicalize().map_err(|e| e.to_string())?;
    let arquivo = PathBuf::from(&caminho).canonicalize().map_err(|e| e.to_string())?;
    if !arquivo.starts_with(&base) || arquivo.extension().is_none_or(|e| e != "jsonl") {
        return Err("não é um transcript do Claude Code".into());
    }

    let mut f = std::fs::File::open(&arquivo).map_err(|e| e.to_string())?;
    let tamanho = f.metadata().map_err(|e| e.to_string())?.len();
    // Menor do que o que já foi lido: o arquivo foi reescrito. Recomeça.
    let mut do_zero = desde > tamanho;
    let mut inicio = if do_zero { 0 } else { desde };
    let cortado = tamanho - inicio > TRANSCRICAO_TETO;
    if cortado {
        inicio = tamanho - TRANSCRICAO_TETO;
        do_zero = true;
    }

    f.seek(SeekFrom::Start(inicio)).map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    f.take(tamanho - inicio).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    // Pulou para o meio do arquivo: a primeira linha veio pela metade.
    let pular = if cortado { bytes.iter().position(|b| *b == b'\n').map_or(bytes.len(), |p| p + 1) } else { 0 };
    let ate = bytes.iter().rposition(|b| *b == b'\n').map_or(pular, |p| (p + 1).max(pular));
    // Quase todo o peso do arquivo é resultado de ferramenta (um arquivo lido, a
    // saída de um comando), que o chat não mostra. Fica aqui: mandar isso para a
    // webview e fazê-la interpretar megabytes de JSON travava a tela.
    let mut texto = String::new();
    for linha in String::from_utf8_lossy(&bytes[pular..ate]).lines() {
        let fala = linha.contains(r#""type":"user""#) || linha.contains(r#""type":"assistant""#);
        if !fala {
            continue;
        }
        if !linha.contains(r#""tool_use_id""#) {
            texto.push_str(linha);
            texto.push('\n');
        } else if let Some(diff) = diff_do_resultado(linha).or_else(|| diff_do_hook(&arquivo, linha)) {
            texto.push_str(&diff);
            texto.push('\n');
        }
    }
    Ok(Trecho {
        texto,
        fim: inicio + ate as u64,
        do_zero,
        cortado,
    })
}

/// O diff que o Claude Code guardou no resultado de uma ferramenta, já enxuto:
/// `{"type":"diff","arquivos":[{"caminho","hunks"}]}`. É o mesmo que o terminal
/// desenha, com os números de linha do arquivo. Vem de dois lugares: o
/// `structuredPatch` de um Edit ou Write, e o `bashEditDiff` de um comando
/// (um `sed -i`, um script) que mexeu em arquivo. O resto do resultado — o
/// arquivo inteiro de antes, num Edit — fica aqui.
fn diff_do_resultado(linha: &str) -> Option<String> {
    use serde_json::{json, Value};
    if !linha.contains(r#""structuredPatch""#) && !linha.contains(r#""bashEditDiff""#) {
        return None;
    }
    let v: Value = serde_json::from_str(linha).ok()?;
    if v.get("isSidechain").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let r = v.get("toolUseResult")?;
    let hunks = |h: &Value| -> Vec<Value> {
        h.as_array()
            .into_iter()
            .flatten()
            .map(|h| json!({ "oldStart": h["oldStart"], "newStart": h["newStart"], "lines": h["lines"] }))
            .collect()
    };
    let mut arquivos = Vec::new();
    if let Some(files) = r.pointer("/bashEditDiff/files").and_then(Value::as_array) {
        for f in files {
            arquivos.push(json!({ "caminho": f["filePath"], "hunks": hunks(&f["hunks"]) }));
        }
    } else if let Some(caminho) = r.get("filePath") {
        let mut h = hunks(&r["structuredPatch"]);
        // Arquivo novo: o Write não traz patch, só o conteúdo.
        if h.is_empty() && r.get("type").and_then(Value::as_str) == Some("create") {
            if let Some(c) = r.get("content").and_then(Value::as_str) {
                let linhas: Vec<String> = c.lines().map(|l| format!("+{l}")).collect();
                h.push(json!({ "oldStart": 0, "newStart": 1, "lines": linhas }));
            }
        }
        arquivos.push(json!({ "caminho": caminho, "hunks": h }));
    }
    arquivos.retain(|a| a["hunks"].as_array().is_some_and(|h| !h.is_empty()));
    if arquivos.is_empty() {
        return None;
    }
    Some(json!({ "type": "diff", "arquivos": arquivos }).to_string())
}

/// O diff que o nosso hook tirou de um Bash, para quando o Claude Code não
/// gravou nenhum (um comando que mexeu em arquivo e terminou com erro). Fica em
/// `~/.termiau/diffs/<sessão>/<tool_use_id>.patch`; a sessão é o nome do
/// transcript.
fn diff_do_hook(transcript: &std::path::Path, linha: &str) -> Option<String> {
    let id = linha.split(r#""tool_use_id":""#).nth(1)?.split('"').next()?;
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return None;
    }
    let sessao = transcript.file_stem()?.to_str()?;
    let patch = PathBuf::from(dirs_home()?).join(".termiau/diffs").join(sessao).join(format!("{id}.patch"));
    let texto = std::fs::read_to_string(patch).ok()?;
    let arquivos = arquivos_do_patch(&texto);
    if arquivos.is_empty() {
        return None;
    }
    Some(serde_json::json!({ "type": "diff", "arquivos": arquivos }).to_string())
}

/// Um `git diff` em arquivos e trechos, no mesmo formato do `structuredPatch`
/// do Claude Code. A primeira linha, `# raiz <pasta>`, é do hook: é dela que os
/// caminhos `a/…` e `b/…` do git viram absolutos. Arquivo binário não tem
/// trecho e fica de fora.
fn arquivos_do_patch(texto: &str) -> Vec<serde_json::Value> {
    use serde_json::json;
    let mut linhas = texto.lines();
    let raiz = linhas.next().and_then(|l| l.strip_prefix("# raiz ")).unwrap_or("");
    let mut arquivos: Vec<serde_json::Value> = Vec::new();
    let mut caminho: Option<String> = None;
    let mut hunks: Vec<serde_json::Value> = Vec::new();
    let mut atual: Option<(u64, u64, Vec<String>)> = None;
    let fechar_hunk = |atual: &mut Option<(u64, u64, Vec<String>)>, hunks: &mut Vec<serde_json::Value>| {
        if let Some((velha, nova, ls)) = atual.take() {
            hunks.push(json!({ "oldStart": velha, "newStart": nova, "lines": ls }));
        }
    };
    let fechar_arquivo =
        |caminho: &mut Option<String>, hunks: &mut Vec<serde_json::Value>, arquivos: &mut Vec<serde_json::Value>| {
            if let Some(c) = caminho.take() {
                if !hunks.is_empty() {
                    arquivos.push(json!({ "caminho": c, "hunks": std::mem::take(hunks) }));
                }
            }
            hunks.clear();
        };
    // O início de um trecho: `@@ -velha[,n] +nova[,n] @@`.
    let inicio = |l: &str| -> Option<(u64, u64)> {
        let mut partes = l.strip_prefix("@@ ")?.split(' ');
        let num = |p: &str| p.split(',').next().and_then(|n| n.parse::<u64>().ok());
        Some((num(partes.next()?.strip_prefix('-')?)?, num(partes.next()?.strip_prefix('+')?)?))
    };
    for l in linhas {
        if l.starts_with("diff --git ") {
            fechar_hunk(&mut atual, &mut hunks);
            fechar_arquivo(&mut caminho, &mut hunks, &mut arquivos);
        } else if atual.is_none() && (l.starts_with("--- ") || l.starts_with("+++ ")) {
            // O `+++ b/…` diz o nome; num arquivo apagado ele é /dev/null, e
            // vale o `--- a/…` que veio antes.
            if let Some(p) = l[4..].strip_prefix("a/").or_else(|| l[4..].strip_prefix("b/")) {
                caminho = Some(format!("{}/{}", raiz.trim_end_matches('/'), p));
            }
        } else if let Some((velha, nova)) = inicio(l) {
            fechar_hunk(&mut atual, &mut hunks);
            atual = Some((velha, nova, Vec::new()));
        } else if let Some((_, _, ls)) = atual.as_mut() {
            if l.starts_with([' ', '+', '-', '\\']) {
                ls.push(l.to_string());
            } else {
                fechar_hunk(&mut atual, &mut hunks);
            }
        }
    }
    fechar_hunk(&mut atual, &mut hunks);
    fechar_arquivo(&mut caminho, &mut hunks, &mut arquivos);
    arquivos
}

/// Um `/comando` que o Claude Code aceita além dos que já vêm nele: os comandos
/// e as skills do usuário, do projeto e dos plugins instalados.
#[derive(serde::Serialize)]
struct Comando {
    nome: String,
    descricao: String,
}

/// A `description:` do cabeçalho de um comando ou de uma skill. Só o começo do
/// arquivo é lido, e só a primeira linha dela interessa: é o que cabe na lista.
fn descricao_de(arquivo: &std::path::Path) -> String {
    let mut texto = String::new();
    let Ok(f) = std::fs::File::open(arquivo) else { return texto };
    let _ = f.take(16 * 1024).read_to_string(&mut texto);
    let mut linhas = texto.lines();
    if linhas.next().map(str::trim) != Some("---") {
        return String::new();
    }
    linhas
        .take_while(|l| l.trim() != "---")
        .find_map(|l| l.strip_prefix("description:"))
        .map(|d| d.trim().trim_matches(['"', '\'']).chars().take(160).collect())
        .unwrap_or_default()
}

/// Os `.md` de uma pasta de comandos. Subpasta vira prefixo, como no Claude
/// Code: `commands/git/commit.md` é o `/git:commit`.
fn comandos_da_pasta(dir: &std::path::Path, prefixo: &str, fundo: u8, saida: &mut Vec<Comando>) {
    let Ok(itens) = std::fs::read_dir(dir) else { return };
    for item in itens.flatten() {
        let caminho = item.path();
        let Some(nome) = caminho.file_stem().and_then(|n| n.to_str()) else { continue };
        if caminho.is_dir() {
            if fundo > 0 {
                comandos_da_pasta(&caminho, &format!("{prefixo}{nome}:"), fundo - 1, saida);
            }
        } else if caminho.extension().is_some_and(|e| e == "md") {
            saida.push(Comando { nome: format!("{prefixo}{nome}"), descricao: descricao_de(&caminho) });
        }
    }
}

/// As skills de uma pasta: cada subpasta com um `SKILL.md` é uma.
fn skills_da_pasta(dir: &std::path::Path, prefixo: &str, saida: &mut Vec<Comando>) {
    let Ok(itens) = std::fs::read_dir(dir) else { return };
    for item in itens.flatten() {
        let skill = item.path().join("SKILL.md");
        let Some(nome) = item.file_name().to_str().map(str::to_owned) else { continue };
        if skill.is_file() {
            saida.push(Comando { nome: format!("{prefixo}{nome}"), descricao: descricao_de(&skill) });
        }
    }
}

/// O que dá para chamar com `/` na sessão que roda em `pasta`, fora os
/// comandos embutidos do Claude Code (esses a webview já conhece). O projeto
/// vem antes do usuário, e o usuário antes dos plugins: é a ordem em que a
/// lista mostra, e o que é do projeto é o que mais se usa nele.
#[tauri::command]
fn comandos_listar(pasta: Option<String>) -> Vec<Comando> {
    let mut saida = Vec::new();
    if let Some(pasta) = pasta {
        // Subindo a partir da pasta da sessão, como o Claude Code faz: a sessão
        // aberta numa subpasta ainda enxerga o `.claude` da raiz do projeto.
        for dir in std::path::Path::new(&pasta).ancestors() {
            let claude = dir.join(".claude");
            // O `~/.claude` é o do usuário, e entra logo abaixo.
            if dir_claude().is_some_and(|d| d == claude) {
                break;
            }
            comandos_da_pasta(&claude.join("commands"), "", 3, &mut saida);
            skills_da_pasta(&claude.join("skills"), "", &mut saida);
        }
    }
    let Some(base) = dir_claude() else { return saida };
    comandos_da_pasta(&base.join("commands"), "", 3, &mut saida);
    skills_da_pasta(&base.join("skills"), "", &mut saida);

    // Cada plugin instalado traz os seus, chamados como `/plugin:nome`.
    let plugins = std::fs::read_to_string(base.join("plugins/installed_plugins.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok());
    if let Some(mapa) = plugins.as_ref().and_then(|p| p["plugins"].as_object()) {
        for (chave, instalacoes) in mapa {
            let plugin = chave.split('@').next().unwrap_or(chave);
            for inst in instalacoes.as_array().into_iter().flatten() {
                let Some(raiz) = inst["installPath"].as_str().map(PathBuf::from) else { continue };
                let prefixo = format!("{plugin}:");
                comandos_da_pasta(&raiz.join("commands"), &prefixo, 3, &mut saida);
                skills_da_pasta(&raiz.join("skills"), &prefixo, &mut saida);
            }
        }
    }
    saida
}

/// As perguntas do Claude (`AskUserQuestion`) esperando resposta do modo chat:
/// a conexão do hook fica aberta aqui, por um número dado a ela ao chegar (o
/// `PermissionRequest` não traz o `tool_use_id`), até o chat responder
/// (`pergunta_responder`) ou desistir dela (`pergunta_largar`).
#[derive(Default)]
struct Pendentes(Mutex<HashMap<String, std::os::unix::net::UnixStream>>);

/// Devolve ao hook a decisão que o chat montou, e fecha a conexão: o que for
/// escrito aqui é a saída do hook, e o Claude Code a lê como a resposta.
#[tauri::command]
fn pergunta_responder(pendentes: State<'_, Pendentes>, id: String, resposta: String) -> Result<(), String> {
    let Some(mut fluxo) = pendentes.0.lock().unwrap().remove(&id) else {
        return Err("a pergunta já foi respondida".into());
    };
    fluxo.write_all(resposta.as_bytes()).map_err(|e| e.to_string())
}

/// Fecha a conexão sem resposta: o hook sai calado e a pergunta fica com o
/// terminal. É o que acontece quando ela foi respondida lá.
#[tauri::command]
fn pergunta_largar(pendentes: State<'_, Pendentes>, id: String) {
    pendentes.0.lock().unwrap().remove(&id);
}

/// Escuta os eventos que os hooks do Claude Code mandam e entrega pra webview.
/// Um socket unix, uma conexão por evento: o hook escreve um JSON e fecha. A
/// exceção é a pergunta do Claude: ela chega com `"espera":true` e uma quebra
/// de linha no fim, e a conexão fica aberta esperando a resposta (ver
/// `Pendentes`).
///
/// Por que socket e não sequência de escape pela própria saída do painel: a
/// segunda seria mais elegante (a identidade do painel viria de graça), mas o
/// hook e o Claude Code escrevem no mesmo tty ao mesmo tempo, e um `delta` de
/// alguns KB passa do tamanho em que a escrita deixa de ser atômica — o risco é
/// picar uma sequência do próprio Claude e sujar a tela.
fn ouvir_hooks(app: AppHandle, caminho: PathBuf) {
    let _ = std::fs::remove_file(&caminho);
    limpar_sockets_orfaos(&caminho);
    let ouvinte = match UnixListener::bind(&caminho) {
        Ok(l) => l,
        Err(e) => return eprintln!("[termiau] não consegui abrir {caminho:?}: {e}"),
    };

    std::thread::spawn(move || {
        for conexao in ouvinte.incoming() {
            let Ok(fluxo) = conexao else { continue };
            let app = app.clone();
            // Uma thread por evento: um hook lento não pode segurar a fila dos outros.
            std::thread::spawn(move || {
                use std::io::BufRead;
                let mut texto = String::new();
                // Até a quebra de linha ou o fim, o que vier antes. Teto pra um
                // payload absurdo não virar memória sem fim.
                let Ok(leitor) = fluxo.try_clone() else { return };
                if std::io::BufReader::new(leitor.take(256 * 1024)).read_line(&mut texto).is_err() {
                    return;
                }
                if texto.trim().is_empty() {
                    return;
                }
                // A pergunta ganha um número, que vai junto para a webview: é
                // por ele que a resposta volta para esta conexão.
                let texto = match pergunta_em_espera(&texto) {
                    Some(mut v) => {
                        static PROXIMA: AtomicU64 = AtomicU64::new(1);
                        let id = format!("pergunta-{}", PROXIMA.fetch_add(1, Ordering::Relaxed));
                        v["pergunta_id"] = id.clone().into();
                        app.state::<Pendentes>().0.lock().unwrap().insert(id, fluxo);
                        v.to_string()
                    }
                    None => texto,
                };
                let _ = app.emit("claude://evento", texto);
            });
        }
    });
}

/// O evento, já lido, se for uma pergunta que espera resposta.
fn pergunta_em_espera(texto: &str) -> Option<serde_json::Value> {
    let v: serde_json::Value = serde_json::from_str(texto.trim()).ok()?;
    (v["espera"].as_bool() == Some(true)).then_some(v)
}

// ---------- o visor: um arquivo mostrado dentro do painel ----------

/// O comando que o Claude (ou você) roda para abrir um arquivo no painel:
/// `termiau ver arquivo:linha`. Ele só fala com o socket, como o hook.
const CLI: &str = include_str!("../../hooks/termiau");

fn dir_cli() -> Option<PathBuf> {
    dirs_home().map(|h| PathBuf::from(h).join(".termiau/bin"))
}

/// Escreve o `termiau` em ~/.termiau/bin a cada abertura do app, se mudou. Fica
/// fora do bundle porque o shell do painel precisa achá-lo por um caminho fixo,
/// e é por esse caminho que o hook o ensina ao Claude.
fn instalar_cli() {
    use std::os::unix::fs::PermissionsExt;
    let Some(dir) = dir_cli() else { return };
    let destino = dir.join("termiau");
    if std::fs::read_to_string(&destino).is_ok_and(|t| t == CLI) {
        return;
    }
    let feito = std::fs::create_dir_all(&dir)
        .and_then(|_| std::fs::write(&destino, CLI))
        .and_then(|_| std::fs::set_permissions(&destino, std::fs::Permissions::from_mode(0o755)));
    if let Err(e) = feito {
        eprintln!("[termiau] não consegui instalar {destino:?}: {e}");
    }
}

/// Acima disto o visor não abre: é um arquivo para ler, não um log de gigas.
const VISOR_MAX: u64 = 5 * 1024 * 1024;

#[derive(serde::Serialize)]
struct Arquivo {
    linhas: Vec<String>,
    /// Muda quando o arquivo muda no disco: é o que o visor compara para se
    /// redesenhar enquanto o Claude edita. Vazio numa versão do git, que não muda.
    carimbo: String,
}

fn carimbo(caminho: &std::path::Path) -> Option<String> {
    let m = std::fs::metadata(caminho).ok()?;
    let quando = m.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(format!("{}:{}", quando.as_nanos(), m.len()))
}

fn texto_do_visor(bytes: Vec<u8>) -> Result<Vec<String>, String> {
    if bytes.len() as u64 > VISOR_MAX {
        return Err("arquivo grande demais para o visor (mais de 5 MB)".into());
    }
    // O mesmo palpite do git: um NUL no começo é arquivo binário.
    if bytes.iter().take(8000).any(|&b| b == 0) {
        return Err("é um arquivo binário".into());
    }
    let texto = String::from_utf8_lossy(&bytes);
    let texto = texto.strip_suffix('\n').unwrap_or(&texto);
    Ok(texto.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l).to_string()).collect())
}

/// O arquivo inteiro, em linhas. Com `rf`, como ele está naquele commit ou
/// branch (`git show <rf>:./<arquivo>`), e não no disco — é o "como era na main".
#[tauri::command(async)]
fn arquivo_ler(caminho: String, rf: Option<String>) -> Result<Arquivo, String> {
    let p = std::path::Path::new(&caminho);
    if !p.is_absolute() {
        return Err(format!("caminho relativo: {caminho}"));
    }
    let Some(rf) = rf.filter(|r| !r.is_empty()) else {
        if !p.is_file() {
            return Err(format!("não existe: {caminho}"));
        }
        let bytes = std::fs::read(p).map_err(|e| e.to_string())?;
        return Ok(Arquivo { linhas: texto_do_visor(bytes)?, carimbo: carimbo(p).unwrap_or_default() });
    };
    // Uma ref que começa com `-` viraria opção do git.
    if rf.starts_with('-') || rf.contains(char::is_whitespace) {
        return Err(format!("ref inválida: {rf}"));
    }
    let pasta = p.parent().ok_or("caminho sem pasta")?;
    let nome = p.file_name().ok_or("caminho sem nome")?.to_string_lossy();
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(pasta)
        .arg("show")
        .arg(format!("{rf}:./{nome}"))
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        let erro = String::from_utf8_lossy(&out.stderr);
        return Err(erro.lines().next().unwrap_or("git show falhou").to_string());
    }
    Ok(Arquivo { linhas: texto_do_visor(out.stdout)?, carimbo: String::new() })
}

/// Barato o bastante para o visor perguntar a cada segundo: só o `stat`.
#[tauri::command]
fn arquivo_carimbo(caminho: String) -> Option<String> {
    carimbo(std::path::Path::new(&caminho))
}

/// Quais destes caminhos (relativos a `base`, absolutos ou com `~`) são arquivos
/// que existem, já absolutos. É o que separa um `user_repository.dart:103` de
/// verdade de um `e.g.` qualquer na saída do terminal.
#[tauri::command(async)]
fn arquivos_existem(base: String, candidatos: Vec<String>) -> Vec<Option<String>> {
    let home = dirs_home().unwrap_or_default();
    candidatos
        .into_iter()
        .map(|c| {
            let p = if let Some(resto) = c.strip_prefix("~/") {
                PathBuf::from(&home).join(resto)
            } else {
                PathBuf::from(&base).join(&c)
            };
            p.is_file().then(|| p.to_string_lossy().into_owned())
        })
        .collect()
}

/// Abre o arquivo no editor, na linha. `comando` é o das Preferências, com
/// `{arquivo}` e `{linha}`, rodado num shell interativo de login: é o que lê o
/// .zshrc, onde moram os aliases (um `work='codium .'`) e o PATH do `cursor`,
/// do `zed` e do `code`. Roda na raiz do repositório do arquivo, para um `.`
/// no alias ser o projeto, e não a pasta do app. Sem ele, o VS Code pelo `vscode://`, que
/// pula para a linha mesmo com o editor já aberto e não precisa do `code`.
#[tauri::command(async)]
fn abrir_no_editor(caminho: String, linha: Option<u32>, comando: Option<String>) -> Result<(), String> {
    if !std::path::Path::new(&caminho).is_absolute() {
        return Err(format!("caminho relativo: {caminho}"));
    }
    let linha = linha.unwrap_or(1);
    let Some(comando) = comando.map(|c| c.trim().to_string()).filter(|c| !c.is_empty()) else {
        // Percent-encoding do que não é seguro numa URL: o espaço de um
        // "/Volumes/External MacOS" quebraria o link.
        let codificado: String = caminho
            .bytes()
            .map(|b| match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'/' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
                _ => format!("%{b:02X}"),
            })
            .collect();
        let url = format!("vscode://file{codificado}:{linha}");
        std::process::Command::new("/usr/bin/open").arg(url).spawn().map_err(|e| e.to_string())?;
        return Ok(());
    };
    let linha_de_comando = comando_do_editor(&comando, &caminho, linha);
    let pasta = std::path::Path::new(&caminho).parent().unwrap_or(std::path::Path::new("/")).to_path_buf();
    let raiz = std::process::Command::new("git")
        .arg("-C")
        .arg(&pasta)
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| PathBuf::from(String::from_utf8_lossy(&o.stdout).trim()))
        .unwrap_or(pasta);
    let sh = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut filho = std::process::Command::new(sh)
        .args(["-i", "-l", "-c", &linha_de_comando])
        .current_dir(raiz)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    // O `code -g` volta na hora; um editor que fica preso ao terminal (`--wait`)
    // não pode segurar o botão. Até 5 s para saber se deu erro, depois solta.
    for _ in 0..50 {
        match filho.try_wait().map_err(|e| e.to_string())? {
            Some(st) if st.success() => return Ok(()),
            Some(st) => {
                let mut erro = String::new();
                if let Some(mut e) = filho.stderr.take() {
                    let _ = e.read_to_string(&mut erro);
                }
                // A última linha: as primeiras são do .zshrc (o prompt, avisos de
                // plugin), e o erro do comando vem depois delas.
                let ultima = erro.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("").to_string();
                return Err(if ultima.is_empty() { format!("o comando saiu com {st}") } else { ultima });
            }
            None => std::thread::sleep(std::time::Duration::from_millis(100)),
        }
    }
    std::thread::spawn(move || {
        let _ = filho.wait();
    });
    Ok(())
}

/// O comando das Preferências com o arquivo e a linha no lugar. O caminho vai
/// entre aspas simples (um espaço no nome não parte o argumento); sem
/// `{arquivo}` no comando, ele vai no fim.
fn comando_do_editor(comando: &str, caminho: &str, linha: u32) -> String {
    let citado = format!("'{}'", caminho.replace('\'', "'\\''"));
    let com_linha = comando.replace("{linha}", &linha.to_string());
    if com_linha.contains("{arquivo}") {
        com_linha.replace("{arquivo}", &citado)
    } else {
        format!("{com_linha} {citado}")
    }
}

// ---------- hooks: a instalação, de dentro do app ----------

/// O hook vai dentro do binário: quem baixou só o app não tem o repositório de
/// onde rodar o `hooks/instalar.sh`. Aquele script continua valendo e faz o
/// mesmo que o `hooks_instalar` daqui.
const HOOK: &str = include_str!("../../hooks/termiau-evento.sh");
const HOOK_EVENTOS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PermissionRequest",
    "Notification",
    "SessionEnd",
    "Stop",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
];

/// Como o nosso hook fica registrado em cada evento.
///
/// Os de ferramenta só interessam no Bash — a foto de antes e de depois de um
/// comando, para o diff que o Claude Code não grava (ver `diff_do_bash` no
/// hook) — e, depois dela, na pergunta do Claude: é o aviso de que ela foi
/// respondida no terminal e o cartão do chat pode sair. Sem o matcher, o hook
/// rodaria a cada Read.
///
/// O `PermissionRequest` tem uma hora: numa pergunta do Claude, o hook fica
/// esperando a resposta do chat (ver `Pendentes`). Nos outros pedidos ele
/// devolve na hora, como os demais.
fn grupo_do_evento(evento: &str, comando: &str) -> serde_json::Value {
    let timeout = if evento == "PermissionRequest" { 3600 } else { 5 };
    let mut grupo = serde_json::json!({
        "hooks": [{ "type": "command", "command": comando, "timeout": timeout }]
    });
    match evento {
        "PreToolUse" => grupo["matcher"] = "Bash".into(),
        "PostToolUse" | "PostToolUseFailure" => grupo["matcher"] = "Bash|AskUserQuestion".into(),
        _ => {}
    }
    grupo
}

fn dir_claude() -> Option<PathBuf> {
    dirs_home().map(|h| PathBuf::from(h).join(".claude"))
}

fn hook_nosso(h: &serde_json::Value) -> bool {
    h["command"].as_str().is_some_and(|c| c.contains("termiau-evento"))
}

/// A `statusLine` passa pelo mesmo hook, com o argumento `status`: é por ela
/// que o app recebe o contexto da sessão e o uso do Claude (ver o começo do
/// termiau-evento.sh). Uma status line que não é a nossa fica onde está —
/// quem a pôs ali quis outra coisa.
fn status_line_em_dia(settings: &serde_json::Value) -> bool {
    let s = &settings["statusLine"];
    s.is_object() && !hook_nosso(s) || s["command"].as_str().is_some_and(|c| c.ends_with(" status"))
}

fn status_line(comando: &str) -> serde_json::Value {
    serde_json::json!({ "type": "command", "command": format!("{comando} status"), "padding": 0 })
}

/// O settings.json já chama o nosso hook em todos os eventos, e do jeito que
/// esta versão o registra: um matcher ou um timeout que mudou também pede a
/// reinstalação.
fn hooks_registrados(settings: &serde_json::Value) -> bool {
    status_line_em_dia(settings) && HOOK_EVENTOS.iter().all(|e| {
        settings["hooks"][*e].as_array().is_some_and(|grupos| {
            grupos.iter().any(|g| {
                let Some(nosso) = g["hooks"].as_array().and_then(|hs| hs.iter().find(|h| hook_nosso(h))) else {
                    return false;
                };
                let esperado = grupo_do_evento(e, nosso["command"].as_str().unwrap_or(""));
                g["matcher"] == esperado["matcher"] && nosso["timeout"] == esperado["hooks"][0]["timeout"]
            })
        })
    })
}

/// Em que pé está a ligação com o Claude Code: `sem-claude` (não há `~/.claude`),
/// `ausente` (nunca instalado), `desatualizado` (instalado por uma versão
/// anterior do app) ou `instalado`.
#[tauri::command]
fn hooks_estado() -> &'static str {
    let Some(dir) = dir_claude().filter(|d| d.is_dir()) else { return "sem-claude" };
    let script = dir.join("hooks/termiau-evento.sh");
    if !script.exists() {
        return "ausente";
    }
    let script_em_dia = std::fs::read_to_string(&script).is_ok_and(|s| s == HOOK);
    let registrado = std::fs::read_to_string(dir.join("settings.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .is_some_and(|s| hooks_registrados(&s));
    if script_em_dia && registrado { "instalado" } else { "desatualizado" }
}

/// Copia o hook para `~/.claude/hooks` e o registra no settings.json do Claude
/// Code. Idempotente, e o settings ganha um backup ao lado antes de ser mexido.
#[tauri::command]
fn hooks_instalar() -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    let dir = dir_claude().ok_or("não achei a pasta do usuário")?;
    let destino = dir.join("hooks/termiau-evento.sh");
    std::fs::create_dir_all(dir.join("hooks")).map_err(|e| e.to_string())?;
    std::fs::write(&destino, HOOK).map_err(|e| e.to_string())?;
    std::fs::set_permissions(&destino, std::fs::Permissions::from_mode(0o755))
        .map_err(|e| e.to_string())?;

    let caminho = dir.join("settings.json");
    let texto = match std::fs::read_to_string(&caminho) {
        Ok(t) => Some(t),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.to_string()),
    };
    // Um settings.json que não dá para ler não é reescrito: melhor ficar sem o
    // hook do que apagar a configuração de alguém.
    let mut settings: serde_json::Value = match texto.as_deref().map(str::trim) {
        None | Some("") => serde_json::json!({}),
        Some(t) => serde_json::from_str(t)
            .map_err(|e| format!("o settings.json do Claude Code está ilegível: {e}"))?,
    };
    if hooks_registrados(&settings) {
        return Ok(());
    }
    settings
        .as_object_mut()
        .ok_or("o settings.json do Claude Code não é um objeto")?
        .entry("hooks")
        .or_insert_with(|| serde_json::json!({}));

    let comando = format!("bash {}", destino.display());
    if !status_line_em_dia(&settings) {
        settings["statusLine"] = status_line(&comando);
    }
    let hooks = settings["hooks"].as_object_mut().ok_or("o \"hooks\" do settings.json do Claude Code não é um objeto")?;
    for evento in HOOK_EVENTOS {
        // Sai qualquer registro anterior do nosso hook, entra um novo no fim.
        let mut grupos =
            hooks.get(*evento).and_then(|v| v.as_array()).cloned().unwrap_or_default();
        for g in &mut grupos {
            if let Some(hs) = g.get_mut("hooks").and_then(|h| h.as_array_mut()) {
                hs.retain(|h| !hook_nosso(h));
            }
        }
        grupos.retain(|g| g["hooks"].as_array().is_some_and(|hs| !hs.is_empty()));
        grupos.push(grupo_do_evento(evento, &comando));
        hooks.insert(evento.to_string(), serde_json::Value::Array(grupos));
    }

    if texto.is_some() {
        let agora = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        std::fs::copy(&caminho, dir.join(format!("settings.json.bak-{agora}")))
            .map_err(|e| e.to_string())?;
    }
    let novo = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    // Escrita direta, sem trocar de nome: o settings.json de quem usa dotfiles
    // é um link, e um `rename` por cima poria um arquivo no lugar dele.
    std::fs::write(&caminho, novo + "\n").map_err(|e| e.to_string())
}

/// Sobra um socket por execução que morreu sem sair limpo (um `kill`, um crash).
/// Como o nome carrega o pid, dá pra saber quais não têm mais dono.
fn limpar_sockets_orfaos(atual: &PathBuf) {
    let Some(dir) = atual.parent() else { return };
    let Ok(entradas) = std::fs::read_dir(dir) else { return };
    for e in entradas.flatten() {
        let caminho = e.path();
        if caminho == *atual {
            continue;
        }
        let Some(pid) = caminho
            .file_name()
            .and_then(|n| n.to_str())
            .and_then(|n| n.strip_prefix("termiau-"))
            .and_then(|n| n.strip_suffix(".sock"))
            .and_then(|n| n.parse::<i32>().ok())
        else {
            continue;
        };
        // Sinal 0 não faz nada: só pergunta se o processo ainda existe.
        if unsafe { libc::kill(pid, 0) } != 0 {
            let _ = std::fs::remove_file(&caminho);
        }
    }
}

// ---------- escuta: transcrição da fala ----------

/// Equilíbrio recomendado para português — 466 MB. Os outros do catálogo
/// continuam em `escuta::model` para quando houver uma tela de ajustes.
const MODELO: &str = "small";
const IDIOMA: &str = "pt";

#[derive(Default)]
struct Escuta {
    /// Marcada para pedir que as três threads da sessão parem.
    parar: Mutex<Option<Arc<AtomicBool>>>,
}

fn dir_dados(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| format!("sem diretório de dados: {e}"))
}

/// Onde está o modelo. Procura primeiro o nosso e depois o do app Escuta, que
/// era um projeto à parte: quem já baixou 466 MB lá não precisa baixar de novo.
fn caminho_modelo(app: &AppHandle) -> Result<PathBuf, String> {
    let nosso = escuta::model::path_for(&dir_dados(app)?, MODELO);
    if nosso.exists() {
        return Ok(nosso);
    }
    let herdado = dirs_home()
        .map(PathBuf::from)
        .map(|h| h.join("Library/Application Support/ai.dimenso.escuta/models"))
        .map(|d| d.join(format!("ggml-{MODELO}.bin")));
    match herdado {
        Some(p) if p.exists() => Ok(p),
        _ => Ok(nosso), // não existe ainda; o caminho é onde o download vai cair
    }
}

#[tauri::command]
fn escuta_modelo_pronto(app: AppHandle) -> Result<bool, String> {
    Ok(caminho_modelo(&app)?.exists())
}

/// Baixa o modelo, contando o progresso em `escuta://progresso` (0 a 1).
#[tauri::command]
async fn escuta_baixar_modelo(app: AppHandle) -> Result<(), String> {
    let dir = dir_dados(&app)?;
    std::fs::create_dir_all(escuta::model::dir(&dir)).map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let aviso = app.clone();
        escuta::model::download(&dir, MODELO, move |frac, _, _| {
            let _ = aviso.emit("escuta://progresso", frac);
        })
        .map(|_| ())
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Liga o microfone. Três threads: captura, medidor de nível e transcrição —
/// o `cpal::Stream` tem que viver inteiro na thread que o abriu.
#[tauri::command]
fn escuta_comecar(app: AppHandle, state: State<'_, Escuta>) -> Result<(), String> {
    let mut guarda = state.parar.lock().unwrap();
    // Uma sessão que morreu sozinha (microfone sumiu, modelo corrompido) deixa
    // a marca para trás; limpa antes de decidir se ainda estamos escutando.
    if guarda.as_ref().is_some_and(|p| p.load(Ordering::Relaxed)) {
        *guarda = None;
    }
    if guarda.is_some() {
        return Err("já estou escutando".into());
    }

    let modelo = caminho_modelo(&app)?;
    if !modelo.exists() {
        return Err("o modelo ainda não foi baixado".into());
    }

    let parar = Arc::new(AtomicBool::new(false));
    let (audio_tx, audio_rx) = std::sync::mpsc::channel::<Vec<f32>>();
    let (nivel_tx, nivel_rx) = std::sync::mpsc::channel::<f32>();

    // 1) captura
    {
        let parar = parar.clone();
        let app = app.clone();
        std::thread::spawn(move || {
            if let Err(e) = escuta::audio::capture(None, audio_tx, nivel_tx, parar.clone()) {
                let _ = app.emit("escuta://erro", e.to_string());
                parar.store(true, Ordering::Relaxed);
                let _ = app.emit("escuta://estado", "parado");
            }
        });
    }

    // 2) medidor: agrega o pico e emite ~20x por segundo, senão seria um evento
    //    por buffer de áudio.
    {
        let parar = parar.clone();
        let app = app.clone();
        std::thread::spawn(move || {
            while !parar.load(Ordering::Relaxed) {
                let mut pico = 0.0f32;
                let limite = std::time::Instant::now() + std::time::Duration::from_millis(50);
                while std::time::Instant::now() < limite {
                    match nivel_rx.recv_timeout(std::time::Duration::from_millis(50)) {
                        Ok(v) => pico = pico.max(v),
                        Err(_) => break,
                    }
                }
                let _ = app.emit("escuta://nivel", pico);
            }
            let _ = app.emit("escuta://nivel", 0.0);
        });
    }

    // 3) transcrição
    {
        let parar = parar.clone();
        let app = app.clone();
        let caminho = modelo.to_string_lossy().into_owned();
        std::thread::spawn(move || {
            let motor = match escuta::stt::Engine::load(&caminho, IDIOMA) {
                Ok(m) => m,
                Err(e) => {
                    let _ = app.emit("escuta://erro", e.to_string());
                    parar.store(true, Ordering::Relaxed);
                    let _ = app.emit("escuta://estado", "parado");
                    return;
                }
            };
            escuta::stt::run(motor, audio_rx, parar, |ev| match ev {
                escuta::stt::Event::Partial(t) => { let _ = app.emit("escuta://parcial", t); }
                escuta::stt::Event::Final(t) => { let _ = app.emit("escuta://final", t); }
                escuta::stt::Event::Status(s) => { let _ = app.emit("escuta://estado", s); }
                escuta::stt::Event::Error(e) => { let _ = app.emit("escuta://erro", e); }
            });
        });
    }

    *guarda = Some(parar);
    Ok(())
}

#[tauri::command]
fn escuta_parar(state: State<'_, Escuta>) {
    if let Some(parar) = state.parar.lock().unwrap().take() {
        parar.store(true, Ordering::Relaxed);
    }
}

// ---------- sessão: as abas que voltam na próxima abertura ----------

/// Um arquivo só, na pasta de dados do app: as abas abertas, o layout de cada
/// uma e a sessão do Claude de cada painel. Quem monta e quem lê é a webview —
/// daqui só sai e entra texto. Em arquivo, e não no localStorage: a webview
/// grava o dela quando bem entende, e o app sai por `_exit` (ver `run`).
fn arquivo_sessao(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(dir_dados(app)?.join("sessao.json"))
}

/// Voltar com as abas é escolha de quem usa (TermIAu ▸ Restaurar Abas ao
/// Abrir), e nasce desligada. A escolha é a existência deste arquivo: o menu é
/// montado aqui no Rust, antes de a webview existir para dizer qualquer coisa.
fn marca_restaurar(app: &AppHandle) -> Option<PathBuf> {
    Some(dir_dados(app).ok()?.join("restaurar-abas"))
}

#[tauri::command]
fn restaurar_ligado(app: AppHandle) -> bool {
    marca_restaurar(&app).is_some_and(|m| m.exists())
}

/// O clique no item do menu. O visto quem troca é o próprio macOS; daqui sai a
/// marca no disco e o aviso para a webview.
fn alternar_restaurar(app: &AppHandle) {
    let Some(marca) = marca_restaurar(app) else { return };
    let ligado = !marca.exists();
    let feito = if ligado {
        marca.parent().map_or(Ok(()), std::fs::create_dir_all).and_then(|_| std::fs::write(&marca, ""))
    } else {
        std::fs::remove_file(&marca)
    };
    if let Err(e) = feito {
        eprintln!("[termiau] não consegui guardar a escolha de restaurar abas: {e}");
    }
    let _ = app.emit("menu://restaurar", marca.exists());
}

/// Desligado, não há o que trazer: a webview abre uma aba nova. A sessão
/// continua sendo gravada do mesmo jeito — ligar no meio do dia já vale para a
/// próxima abertura.
#[tauri::command]
fn sessao_ler(app: AppHandle) -> Option<String> {
    if !restaurar_ligado(app.clone()) {
        return None;
    }
    std::fs::read_to_string(arquivo_sessao(&app).ok()?).ok()
}

#[tauri::command]
fn sessao_salvar(app: AppHandle, dados: String) -> Result<(), String> {
    let destino = arquivo_sessao(&app)?;
    if let Some(dir) = destino.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    // Escreve ao lado e troca de nome: um app morto no meio da escrita deixa o
    // arquivo anterior inteiro, e não meio JSON.
    let rascunho = destino.with_extension("json.tmp");
    std::fs::write(&rascunho, dados).map_err(|e| e.to_string())?;
    std::fs::rename(&rascunho, &destino).map_err(|e| e.to_string())
}

/// Encerra o app. Quem chama é a webview, depois de o usuário confirmar e de a
/// sessão estar salva.
#[tauri::command]
fn sair(app: AppHandle) {
    app.exit(0);
}

/// O menu padrão do Tauri reserva ⌘W para "Close Window" e o menu do macOS
/// consome o atalho antes da webview — a aba nunca via a tecla. Trocamos o menu
/// inteiro para que ⌘T e ⌘W pertençam às abas; os itens nativos de Editar
/// continuam ali porque é deles que ⌘C/⌘V dependem.
fn montar_menu(app: &AppHandle) -> tauri::Result<()> {
    let sobre = Submenu::with_items(
        app,
        "TermIAu",
        true,
        &[
            &PredefinedMenuItem::about(app, Some(tr("Sobre o TermIAu", "About TermIAu")), Some(AboutMetadata::default()))?,
            &PredefinedMenuItem::separator(app)?,
            // ⌘, é onde todo app do macOS guarda isto — e, sendo item de menu,
            // a tecla nem chega na webview: o menu fica com ela antes.
            &MenuItem::with_id(app, "preferencias", tr("Preferências…", "Preferences…"), true, Some("CmdOrCtrl+,"))?,
            // Ligar instala também os hooks do Claude Code, que é de onde vem a
            // sessão a retomar em cada painel.
            &CheckMenuItem::with_id(
                app,
                "restaurar",
                tr("Restaurar Abas ao Abrir", "Restore Tabs on Launch"),
                true,
                restaurar_ligado(app.clone()),
                None::<&str>,
            )?,
            // Os hooks sozinhos, para quem quer só o aviso de "esperando" nas abas.
            &MenuItem::with_id(app, "hooks", tr("Ligar ao Claude Code…", "Connect to Claude Code…"), true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, Some(tr("Serviços", "Services")))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, Some(tr("Ocultar TermIAu", "Hide TermIAu")))?,
            &PredefinedMenuItem::hide_others(app, Some(tr("Ocultar Outros", "Hide Others")))?,
            &PredefinedMenuItem::separator(app)?,
            // Item nosso, e não o `quit` pronto: aquele encerra o app na hora, e
            // um ⌘Q esbarrado leva embora todos os shells. Este só avisa a
            // webview, que pergunta antes (ver `pedirSair` no main.ts).
            &MenuItem::with_id(app, "sair", tr("Sair do TermIAu", "Quit TermIAu"), true, Some("CmdOrCtrl+Q"))?,
        ],
    )?;

    let arquivo = Submenu::with_items(
        app,
        tr("Arquivo", "File"),
        true,
        &[
            &MenuItem::with_id(app, "nova-aba", tr("Nova Aba", "New Tab"), true, Some("CmdOrCtrl+T"))?,
            // Como no navegador: traz de volta a última aba fechada, com o layout
            // dela e as sessões do Claude retomadas.
            &MenuItem::with_id(
                app,
                "reabrir-aba",
                tr("Reabrir Aba Fechada", "Reopen Closed Tab"),
                true,
                Some("CmdOrCtrl+Shift+T"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "dividir-lado", tr("Dividir ao Lado", "Split Right"), true, Some("CmdOrCtrl+D"))?,
            &MenuItem::with_id(
                app,
                "dividir-abaixo",
                tr("Dividir Abaixo", "Split Down"),
                true,
                Some("CmdOrCtrl+Shift+D"),
            )?,
            // Alterna: maximiza o painel em foco ou devolve os outros à tela.
            &MenuItem::with_id(
                app,
                "maximizar",
                tr("Maximizar ou Recolher Painel", "Maximize or Restore Pane"),
                true,
                Some("CmdOrCtrl+Shift+Enter"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            // Fecha o painel em foco; com um só painel, é a aba inteira que vai.
            &MenuItem::with_id(app, "fechar", tr("Fechar", "Close"), true, Some("CmdOrCtrl+W"))?,
            &PredefinedMenuItem::close_window(app, Some(tr("Fechar Janela", "Close Window")))?,
        ],
    )?;

    let editar = Submenu::with_items(
        app,
        tr("Editar", "Edit"),
        true,
        &[
            &PredefinedMenuItem::copy(app, Some(tr("Copiar", "Copy")))?,
            &PredefinedMenuItem::paste(app, Some(tr("Colar", "Paste")))?,
            // O ⌘V cola o nome do arquivo (ou nada, se o Finder não deixou
            // texto); este cola o caminho, que é o que serve de argumento.
            &MenuItem::with_id(
                app,
                "colar-caminho",
                tr("Colar Caminho", "Paste Path"),
                true,
                Some("CmdOrCtrl+Shift+V"),
            )?,
            &PredefinedMenuItem::select_all(app, Some(tr("Selecionar Tudo", "Select All")))?,
        ],
    )?;

    let escuta = Submenu::with_items(
        app,
        tr("Escuta", "Dictation"),
        true,
        &[
            // ⌘E, e não Ctrl+Espaço: no macOS ele troca de fonte de entrada
            // quando há mais de uma instalada. ⌘E fica livre — o menu o consome
            // antes da webview.
            &MenuItem::with_id(app, "escutar", tr("Escutar", "Listen"), true, Some("CmdOrCtrl+E"))?,
        ],
    )?;

    // A rádio do rodapé. O editor fica sem atalho: se abre de vez em quando, e
    // toda tecla presa aqui é uma tecla a menos para o shell. O play não: é o
    // que se aperta sem tirar a mão do teclado.
    let radio = Submenu::with_items(
        app,
        tr("Rádio", "Radio"),
        true,
        &[
            &MenuItem::with_id(app, "radio", tr("Tocar / Pausar", "Play / Pause"), true, Some("CmdOrCtrl+Shift+P"))?,
            &MenuItem::with_id(app, "estacoes", tr("Estações…", "Stations…"), true, None::<&str>)?,
        ],
    )?;

    // Como se vê a sessão do Claude do painel em foco: o terminal dela ou a
    // conversa em balões. E os saltos entre o que você escreveu, que valem nos
    // dois modos — ⌘⇧↑ e ⌘⇧↓ são os das marcas do iTerm2.
    let exibir = Submenu::with_items(
        app,
        tr("Exibir", "View"),
        true,
        &[
            &MenuItem::with_id(
                app,
                "chat",
                tr("Alternar entre Chat e Terminal", "Toggle Chat and Terminal"),
                true,
                Some("CmdOrCtrl+Shift+C"),
            )?,
            &MenuItem::with_id(
                app,
                "visor",
                tr("Mostrar ou Esconder o Arquivo", "Show or Hide File"),
                true,
                Some("CmdOrCtrl+Shift+O"),
            )?,
            &MenuItem::with_id(
                app,
                "compactar",
                tr("Compactar a Conversa do Claude", "Compact Claude Conversation"),
                true,
                Some("CmdOrCtrl+Shift+K"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                "mensagem-anterior",
                tr("Sua Mensagem Anterior", "Your Previous Message"),
                true,
                Some("CmdOrCtrl+Shift+Up"),
            )?,
            &MenuItem::with_id(
                app,
                "mensagem-seguinte",
                tr("Sua Próxima Mensagem", "Your Next Message"),
                true,
                Some("CmdOrCtrl+Shift+Down"),
            )?,
        ],
    )?;

    let janela = Submenu::with_items(
        app,
        tr("Janela", "Window"),
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some(tr("Minimizar", "Minimize")))?,
            &PredefinedMenuItem::fullscreen(app, Some(tr("Tela Cheia", "Enter Full Screen")))?,
        ],
    )?;

    // A lista de atalhos. ⌘/ é o de ajuda na maioria dos apps; como item de
    // menu, a tecla fica com o menu e não chega ao shell.
    let ajuda = Submenu::with_items(
        app,
        tr("Ajuda", "Help"),
        true,
        &[&MenuItem::with_id(app, "atalhos", tr("Atalhos do Teclado", "Keyboard Shortcuts"), true, Some("CmdOrCtrl+/"))?],
    )?;

    app.set_menu(Menu::with_items(
        app,
        &[&sobre, &arquivo, &editar, &exibir, &escuta, &radio, &janela, &ajuda],
    )?)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // O differ guarda num JSON, na pasta de dados do app, a branch alvo de
        // cada repositório e o que já foi revisado.
        .plugin(tauri_plugin_store::Builder::new().build())
        .setup(|app| {
            let cfg = Config::default();
            ouvir_hooks(app.handle().clone(), cfg.socket.clone());
            app.manage(cfg);
            app.manage(Ptys::default());
            app.manage(Escuta::default());
            app.manage(Pendentes::default());
            app.manage(differ::Vigia::default());
            app.manage(differ::Perguntas::default());
            // Sem isto o whisper.cpp despeja o log dele na saída do processo.
            whisper_rs::install_logging_hooks();
            montar_menu(app.handle())?;
            instalar_cli();
            Ok(())
        })
        // O menu só sabe que a tecla foi apertada; quem tem as abas é a webview.
        .on_menu_event(|app, ev| match ev.id().as_ref() {
            "nova-aba" => { let _ = app.emit("menu://nova-aba", ()); }
            "reabrir-aba" => { let _ = app.emit("menu://reabrir-aba", ()); }
            "sair" => { let _ = app.emit("menu://sair", ()); }
            "hooks" => { let _ = app.emit("menu://hooks", ()); }
            "restaurar" => alternar_restaurar(app),
            "dividir-lado" => { let _ = app.emit("menu://dividir-lado", ()); }
            "dividir-abaixo" => { let _ = app.emit("menu://dividir-abaixo", ()); }
            "maximizar" => { let _ = app.emit("menu://maximizar", ()); }
            "fechar" => { let _ = app.emit("menu://fechar", ()); }
            "colar-caminho" => { let _ = app.emit("menu://colar-caminho", ()); }
            "preferencias" => { let _ = app.emit("menu://preferencias", ()); }
            "escutar" => { let _ = app.emit("menu://escutar", ()); }
            "estacoes" => { let _ = app.emit("menu://estacoes", ()); }
            "radio" => { let _ = app.emit("menu://radio", ()); }
            "atalhos" => { let _ = app.emit("menu://atalhos", ()); }
            "chat" => { let _ = app.emit("menu://chat", ()); }
            "visor" => { let _ = app.emit("menu://visor", ()); }
            "compactar" => { let _ = app.emit("menu://compactar", ()); }
            "mensagem-anterior" => { let _ = app.emit("menu://mensagem", -1); }
            "mensagem-seguinte" => { let _ = app.emit("menu://mensagem", 1); }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            pty_spawn,
            pty_attach,
            pty_write,
            abrir_link,
            arquivo_ler,
            arquivo_carimbo,
            arquivos_existem,
            abrir_no_editor,
            pty_resize,
            pty_cwd,
            pty_close,
            pty_close_all,
            escuta_modelo_pronto,
            escuta_baixar_modelo,
            escuta_comecar,
            escuta_parar,
            pty_ocupado,
            pty_sinal,
            sessao_ler,
            sessao_salvar,
            restaurar_ligado,
            hooks_estado,
            hooks_instalar,
            pergunta_responder,
            pergunta_largar,
            sair,
            launch_ler,
            projeto_flutter,
            transcricao_ler,
            comandos_listar,
            area::area_colar,
            differ::open_repo,
            differ::load_diff,
            differ::load_diff_since,
            differ::load_diff_working,
            differ::read_blob,
            differ::read_blob_bytes,
            differ::read_worktree,
            differ::read_worktree_bytes,
            differ::repo_root,
            differ::repo_branch,
            differ::working_stamp,
            differ::stage,
            differ::unstage,
            differ::commit,
            differ::watch_repo,
            differ::claude_sessions,
            differ::ask_claude,
            differ::cancel_ask,
            differ::undo_ask,
            js_log
        ])
        .build(tauri::generate_context!())
        .expect("erro ao montar o TermIAu")
        .run(|app, evento| {
            if let tauri::RunEvent::Exit = evento {
                // O socket é um arquivo de verdade; sem isto ficaria um por
                // execução no diretório temporário.
                let _ = std::fs::remove_file(&app.state::<Config>().socket);

                // E saímos sem passar pelos destrutores estáticos do C++. O
                // ggml libera o device de Metal num deles e aborta no próprio
                // assert quando sobra qualquer resource set vivo — e sobra,
                // porque a thread do whisper ainda está de pé com o contexto na
                // mão quando a janela fecha. Fechar o app imprimia um abort e 20
                // linhas de backtrace (ggml-metal-device.m:608, llama.cpp#17869).
                // Aqui não fica nada para limpar: o socket já saiu, e os shells
                // recebem SIGHUP quando o kernel fecha os pty com o processo.
                unsafe { libc::_exit(0) };
            }
        });
}

#[cfg(test)]
mod testes_patch {
    use super::{arquivos_do_patch, pergunta_em_espera};

    #[test]
    fn so_a_pergunta_que_espera_fica_com_a_conexao() {
        let espera = r#"{"painel":1,"evento":{"tool_name":"AskUserQuestion"},"espera":true}"#;
        assert!(pergunta_em_espera(&format!("{espera}\n")).is_some());
        assert!(pergunta_em_espera(r#"{"painel":1,"evento":{"tool_name":"AskUserQuestion"}}"#).is_none());
        assert!(pergunta_em_espera("lixo").is_none());
    }

    #[test]
    fn le_o_patch_do_hook() {
        let patch = "# raiz /repo\n\
diff --git a/novo.txt b/novo.txt\n\
new file mode 100644\n\
--- /dev/null\n\
+++ b/novo.txt\n\
@@ -0,0 +1 @@\n\
+novo\n\
diff --git a/x.txt b/x.txt\n\
--- a/x.txt\n\
+++ b/x.txt\n\
@@ -1,3 +1,3 @@\n\
 a\n\
-b\n\
+B\n\
@@ -40 +40 @@\n\
--- velho\n\
+++ novo\n\
diff --git a/apagado.txt b/apagado.txt\n\
--- a/apagado.txt\n\
+++ /dev/null\n\
@@ -1 +0,0 @@\n\
-x\n\
diff --git a/img.png b/img.png\n\
Binary files a/img.png and b/img.png differ\n";
        let a = arquivos_do_patch(patch);
        let caminhos: Vec<_> = a.iter().map(|f| f["caminho"].as_str().unwrap()).collect();
        assert_eq!(caminhos, ["/repo/novo.txt", "/repo/x.txt", "/repo/apagado.txt"]);
        assert_eq!(a[0]["hunks"][0]["newStart"], 1);
        // Dentro de um trecho, `--- velho` é uma linha removida, não um cabeçalho.
        assert_eq!(a[1]["hunks"][1]["lines"], serde_json::json!(["--- velho", "+++ novo"]));
        assert_eq!(a[1]["hunks"][0]["oldStart"], 1);
    }
}

#[cfg(test)]
mod testes_visor {
    use super::{arquivo_ler, arquivos_existem, comando_do_editor, texto_do_visor};

    #[test]
    fn comando_do_editor_cita_o_caminho() {
        assert_eq!(
            comando_do_editor("cursor -g {arquivo}:{linha}", "/a b/it's.ts", 7),
            "cursor -g '/a b/it'\\''s.ts':7"
        );
        assert_eq!(comando_do_editor("zed", "/x.md", 1), "zed '/x.md'");
    }

    #[test]
    fn linhas_sem_o_fim_e_sem_cr() {
        assert_eq!(texto_do_visor(b"a\r\nb\n".to_vec()).unwrap(), vec!["a", "b"]);
        assert!(texto_do_visor(b"x\0y".to_vec()).is_err());
    }

    #[test]
    fn le_do_disco_e_de_uma_ref() {
        let aqui = env!("CARGO_MANIFEST_DIR");
        let cargo = format!("{aqui}/Cargo.toml");
        let disco = arquivo_ler(cargo.clone(), None).unwrap();
        assert!(disco.linhas.iter().any(|l| l.starts_with("[package]")));
        assert!(!disco.carimbo.is_empty());
        let head = arquivo_ler(cargo, Some("HEAD".into())).unwrap();
        assert!(head.linhas.iter().any(|l| l.starts_with("[package]")));
        assert!(head.carimbo.is_empty());
        assert!(arquivo_ler("relativo.txt".into(), None).is_err());
        assert!(arquivo_ler(format!("{aqui}/Cargo.toml"), Some("--output=/tmp/x".into())).is_err());
    }

    #[test]
    fn so_os_que_existem() {
        let aqui = env!("CARGO_MANIFEST_DIR").to_string();
        let r = arquivos_existem(aqui.clone(), vec!["Cargo.toml".into(), "nao-existe.rs".into(), "src".into()]);
        assert_eq!(r, vec![Some(format!("{aqui}/Cargo.toml")), None, None]);
    }
}
