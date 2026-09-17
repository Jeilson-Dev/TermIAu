mod area;
mod differ;
mod escuta;

use std::collections::HashMap;
use std::io::{Read, Write};
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
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
            // ⌘, é onde todo app do macOS guarda isto — e, sendo item de menu,
            // a tecla nem chega na webview: o menu fica com ela antes.
            &MenuItem::with_id(app, "preferencias", "Preferências…", true, Some("CmdOrCtrl+,"))?,
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
            // O ⌘V cola o nome do arquivo (ou nada, se o Finder não deixou
            // texto); este cola o caminho, que é o que serve de argumento.
            &MenuItem::with_id(
                app,
                "colar-caminho",
                "Colar Caminho",
                true,
                Some("CmdOrCtrl+Shift+V"),
            )?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    let escuta = Submenu::with_items(
        app,
        "Escuta",
        true,
        &[
            // ⌘E, e não Ctrl+Espaço: no macOS ele troca de fonte de entrada
            // quando há mais de uma instalada. ⌘E fica livre — o menu o consome
            // antes da webview.
            &MenuItem::with_id(app, "escutar", "Escutar", true, Some("CmdOrCtrl+E"))?,
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

    app.set_menu(Menu::with_items(app, &[&sobre, &arquivo, &editar, &escuta, &janela])?)?;
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
            app.manage(differ::Vigia::default());
            // Sem isto o whisper.cpp despeja o log dele na saída do processo.
            whisper_rs::install_logging_hooks();
            montar_menu(app.handle())?;
            Ok(())
        })
        // O menu só sabe que a tecla foi apertada; quem tem as abas é a webview.
        .on_menu_event(|app, ev| match ev.id().as_ref() {
            "nova-aba" => { let _ = app.emit("menu://nova-aba", ()); }
            "dividir-lado" => { let _ = app.emit("menu://dividir-lado", ()); }
            "dividir-abaixo" => { let _ = app.emit("menu://dividir-abaixo", ()); }
            "fechar" => { let _ = app.emit("menu://fechar", ()); }
            "colar-caminho" => { let _ = app.emit("menu://colar-caminho", ()); }
            "preferencias" => { let _ = app.emit("menu://preferencias", ()); }
            "escutar" => { let _ = app.emit("menu://escutar", ()); }
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
            escuta_modelo_pronto,
            escuta_baixar_modelo,
            escuta_comecar,
            escuta_parar,
            pty_ocupado,
            pty_sinal,
            launch_ler,
            projeto_flutter,
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
            differ::working_stamp,
            differ::stage,
            differ::unstage,
            differ::commit,
            differ::watch_repo,
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
