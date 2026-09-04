use std::collections::HashMap;
use std::io::{Read, Write};
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine;
use portable_pty::{Child, ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, State};

/// Tudo que precisamos guardar de uma sessão de PTY viva — uma por aba.
struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
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

/// Caminhos resolvidos uma vez no boot. O app é aberto pelo Finder, com um PATH
/// mínimo que não tem `~/.cargo/bin` nem `~/.local/bin` — procurar `fala_claudio`
/// ou `claude` pelo nome só funcionaria quando aberto de um terminal.
struct Config {
    socket: PathBuf,
    fala: PathBuf,
    claude: PathBuf,
}

/// Primeiro caminho que existe; se nenhum, o nome cru, pra falhar com uma
/// mensagem legível em vez de silenciosamente.
fn achar(nome: &str, candidatos: &[&str]) -> PathBuf {
    let home = dirs_home().unwrap_or_default();
    candidatos
        .iter()
        .map(|c| PathBuf::from(c.replace("~", &home)))
        .find(|p| p.is_file())
        .unwrap_or_else(|| PathBuf::from(nome))
}

impl Default for Config {
    fn default() -> Self {
        Config {
            // O pid no nome deixa duas janelas do TermIAu conviverem sem se
            // roubarem eventos; o hook descobre o caminho pelo ambiente do painel.
            socket: std::env::temp_dir().join(format!("termiau-{}.sock", std::process::id())),
            fala: achar("fala_claudio", &["~/.cargo/bin/fala_claudio", "/usr/local/bin/fala_claudio"]),
            claude: achar("claude", &["~/.local/bin/claude", "/usr/local/bin/claude", "~/.claude/local/claude"]),
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
    cmd.env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin");

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
    drop(pair.slave); // solta o lado escravo, senão nunca vemos o EOF

    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    state.sessions.lock().unwrap().insert(
        id,
        Session {
            master: pair.master,
            writer,
            killer,
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

/// Escuta os eventos que os hooks do Claude Code mandam e entrega pra webview.
/// Um socket unix, uma conexão por evento: o hook escreve um JSON e fecha.
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
                let mut texto = String::new();
                // Teto pra um payload absurdo não virar memória sem fim.
                if fluxo.take(256 * 1024).read_to_string(&mut texto).is_err() {
                    return;
                }
                if !texto.trim().is_empty() {
                    let _ = app.emit("claude://evento", texto);
                }
            });
        }
    });
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

/// Fala um texto com o Fala Cláudio. `--nao-esperar` devolve na hora: a fila é
/// dele, e segurar aqui travaria o evento seguinte.
#[tauri::command]
fn falar(cfg: State<'_, Config>, texto: String) {
    let _ = Command::new(&cfg.fala)
        .args(["--nao-esperar", "--"])
        .arg(texto)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
}

/// Cala o que está sendo falado e esvazia a fila.
#[tauri::command]
fn calar(cfg: State<'_, Config>) {
    let _ = Command::new(&cfg.fala).arg("--parar").stdout(Stdio::null()).stderr(Stdio::null()).spawn();
}

/// Uma frase do que o Claude acabou de dizer, pra ser ouvida em vez de lida.
/// `disableAllHooks` é o que impede a recursão: sem isso este `claude` dispararia
/// o hook de novo e pediria um resumo do resumo, sem fim.
#[tauri::command]
async fn resumir(cfg: State<'_, Config>, texto: String) -> Result<String, String> {
    let claude = cfg.claude.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let saida = Command::new(claude)
            .args(["-p", "--model", "haiku", "--settings", r#"{"disableAllHooks":true}"#])
            .arg(format!(
                "Resuma em UMA frase curta, no maximo 20 palavras, em portugues do Brasil, \
                 para ser ouvida em voz alta. Diga o que foi feito e, se houver, o que eu \
                 preciso decidir. Sem markdown, sem listas, sem nomes de arquivo, comandos \
                 ou caminhos. Responda so a frase. Texto: {texto}"
            ))
            .output()
            .map_err(|e| e.to_string())?;
        Ok(String::from_utf8_lossy(&saida.stdout).trim().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
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
            &PredefinedMenuItem::about(app, None, Some(AboutMetadata::default()))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    let arquivo = Submenu::with_items(
        app,
        "Arquivo",
        true,
        &[
            &MenuItem::with_id(app, "nova-aba", "Nova Aba", true, Some("CmdOrCtrl+T"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "dividir-lado", "Dividir ao Lado", true, Some("CmdOrCtrl+D"))?,
            &MenuItem::with_id(
                app,
                "dividir-abaixo",
                "Dividir Abaixo",
                true,
                Some("CmdOrCtrl+Shift+D"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            // Fecha o painel em foco; com um só painel, é a aba inteira que vai.
            &MenuItem::with_id(app, "fechar", "Fechar", true, Some("CmdOrCtrl+W"))?,
            &PredefinedMenuItem::close_window(app, Some("Fechar Janela"))?,
        ],
    )?;

    let editar = Submenu::with_items(
        app,
        "Editar",
        true,
        &[
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    let janela = Submenu::with_items(
        app,
        "Janela",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;

    app.set_menu(Menu::with_items(app, &[&sobre, &arquivo, &editar, &janela])?)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let cfg = Config::default();
            ouvir_hooks(app.handle().clone(), cfg.socket.clone());
            app.manage(cfg);
            app.manage(Ptys::default());
            montar_menu(app.handle())?;
            Ok(())
        })
        // O menu só sabe que a tecla foi apertada; quem tem as abas é a webview.
        .on_menu_event(|app, ev| match ev.id().as_ref() {
            "nova-aba" => { let _ = app.emit("menu://nova-aba", ()); }
            "dividir-lado" => { let _ = app.emit("menu://dividir-lado", ()); }
            "dividir-abaixo" => { let _ = app.emit("menu://dividir-abaixo", ()); }
            "fechar" => { let _ = app.emit("menu://fechar", ()); }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            pty_spawn,
            pty_attach,
            pty_write,
            pty_resize,
            pty_cwd,
            pty_close,
            pty_close_all,
            falar,
            calar,
            resumir,
            js_log
        ])
        .build(tauri::generate_context!())
        .expect("erro ao montar o TermIAu")
        .run(|app, evento| {
            // O socket é um arquivo de verdade; sem isto ficaria um por execução
            // no diretório temporário.
            if let tauri::RunEvent::Exit = evento {
                let _ = std::fs::remove_file(&app.state::<Config>().socket);
            }
        });
}
