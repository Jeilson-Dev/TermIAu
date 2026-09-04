use std::collections::HashMap;
use std::io::{Read, Write};
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

fn shell(cwd: Option<String>) -> CommandBuilder {
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
    rows: u16,
    cols: u16,
    cwd: Option<String>,
) -> Result<u64, String> {
    let id = state.next_id.fetch_add(1, Ordering::SeqCst);

    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let child = pair.slave.spawn_command(shell(cwd)).map_err(|e| e.to_string())?;
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
            js_log
        ])
        .run(tauri::generate_context!())
        .expect("erro ao subir o TermIAu");
}
