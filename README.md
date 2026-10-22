# TermIAu

<details open>
<summary><b>English</b></summary>

Desktop terminal emulator, with a cat paw in place of the cursor.

A [Tauri 2](https://tauri.app) window draws the grid with [xterm.js](https://xtermjs.org)
and Rust handles the real PTY — the shell running inside is yours (`$SHELL -l`),
with your `.zshrc`, your prompt and your TUIs.

## How it works

```
┌─ webview (TypeScript) ──────────┐        ┌─ Rust (src-tauri) ──────────────┐
│  xterm.js                       │        │  portable-pty                   │
│    onData ──── invoke pty_write ───────► │  ── writer.write_all ─► shell   │
│    write  ◄─── event pty://data ◄─────── │  ◄─ reader thread ───── shell   │
│    ResizeObserver ── pty_resize ───────► │  ── master.resize ──► SIGWINCH  │
└─────────────────────────────────┘        └─────────────────────────────────┘
```

A few details that aren't obvious from the code:

- **Output in base64.** An 8 KB chunk can split a UTF-8 character in half;
  the bytes travel encoded and the front end reassembles them before handing them to xterm.
- **Clean environment.** The shell doesn't inherit the environment of whoever opened the app
  (`npm_*`, `CARGO_*`, `ITERM_SESSION_ID`…). Only a short list goes through
  (`HOME`, `SHELL`, `SSH_AUTH_SOCK`, locale…) plus a minimal bootstrap `PATH` —
  the login shell rebuilds the rest.
- **PTY generations.** Each shell gets a serial number. On every webview reload the
  previous shell is killed, and the thread waiting on it only announces that the
  process ended if it is still the current shell — otherwise the new session would
  be born with the old one's death notice.
- **Debounced resize.** `fit()` runs every frame so the drawing keeps up with the
  drag, but `SIGWINCH` goes out only once, 80 ms after the drag stops.
  Without that the prompt redraws ~45 times during a drag.
- **Paw cursor.** Pure CSS over `.xterm-cursor-block`, with an inline SVG as its
  `background`. It depends on xterm's DOM renderer — loading the `webgl`/`canvas`
  addons would turn the cursor back into a block.

## Requirements

- Node 20+ and npm
- Stable Rust (`rustup`) — the project was built with cargo 1.97
- Tauri 2 prerequisites for your system ([official guide](https://tauri.app/start/prerequisites/))
- The **MesloLGS NF** font installed, if you use Powerlevel10k or another prompt with
  Nerd Font glyphs. Without it the prompt turns into little boxes.

Developed and tested on macOS. The PTY code is portable, but nothing beyond
macOS has been exercised yet.

## Running

```bash
npm install
npm run tauri dev
```

To build the packaged app:

```bash
npm run tauri build
```

The artifacts land in `src-tauri/target/release/bundle/`.

## Turning on the Claude notices

The tabs show where each Claude Code session stands — working, waiting for
you —, and the Claude plugins (below) show the session's context, model and
effort on the panel bar and the usage of the 5h and 7-day limits in the footer.
All of this only arrives through the app's socket, and what writes there is a
hook, which has to be registered in Claude Code's `settings.json`. From the app,
it's **Claude Code ▸ Connect to Claude Code…** (the Claude Code plugin's menu); from
the repo:

```bash
./plugins/claude/hook/install.sh
```

The script copies `termiau-event.sh` to `~/.claude/hooks/` (rather than pointing
to the repo: it may live on a volume that isn't mounted when Claude runs),
registers the events the app handles — `SessionStart`, `UserPromptSubmit`,
`PermissionRequest`, `Notification`, `Stop`, `SessionEnd` and the tool ones
(`PreToolUse`, `PostToolUse`, `PostToolUseFailure`) — and keeps a backup of the
previous settings. Running it again is harmless.

### Context and usage

Context and usage don't come from the events but from the status line: on every
update Claude Code sends it a JSON with the context window and the limits.
That's why the `statusLine` in `settings.json` also has to go through the hook,
with the `status` argument:

```json
"statusLine": {
  "type": "command",
  "command": "bash ~/.claude/hooks/termiau-event.sh status",
  "padding": 0
}
```

The installer only adds that line if you don't have a status line yet — an
existing one stays, and then context and usage don't arrive. To switch, edit
`settings.json` as above. Your old one isn't lost: if it lives in
`~/.claude/statusline-command.sh`, the hook uses it outside TermIAu (iTerm2, VS
Code); inside it the line stays empty, because the app already shows everything.

Without the hook installed the app starts normally, just silent: the tabs show
no Claude state, the bar shows no context, the footer shows no usage and the
Dock badge stays empty.

### The Claude plugins

What shows Claude's state beyond the tabs comes in small plugins, all in the
marketplace, which depend on one core:

- **Claude Code** (`termiau.claude`) — the link: installs and updates the hook,
  follows each panel's session from the hook's events and status lines, and gives
  that to the others through its API. It draws nothing; its hook talks to it
  through the app's socket, which carries each message to the plugin it names.
- **Claude Context** (`termiau.claude-context`) — the pill with the session's
  context on each panel's bar: yellow, then red with the panel's border pulsing;
  click or `⌘⇧K` compacts, and auto-compact can do it on its own. The limits are its
  settings (Preferences ▸ Plugins).
- **Claude Usage** (`termiau.claude-usage`) — the 5-hour session and the week in
  the footer's left corner, with the time left and the pace.
- **Claude Model** (`termiau.claude-model`) — the session's model and effort on
  each panel's bar, one click from `/model` and `/effort`.
- **Claude Chat** (`termiau.claude-chat`) — chat mode, over the terminal.
- **Claude in the Diff** (`termiau.claude-ask`) — asking Claude about a passage of
  the diff tab, loaded into that page (`ctx.differ.extend`).

Installing any of them brings Claude Code along.

## Plugins

TermIAu takes plugins, modeled on VS Code's extensions but organized by **regions**:
the window's areas — the footer, and later the side bar, the tabs and the
preferences — are independent, each one owned by the app, and a plugin declares a
slot in one and draws only inside it.

A plugin is a `.termiau` package: a zip with a `termiau.json` manifest at its root
and the ES module it names. **Preferences (⌘,) ▸ Plugins ▸ Install from file…**
unpacks it into `~/.termiau/plugins/<id>/`; the same tab turns each one on and off
and removes it, and the footer, the menu and the shortcut list follow right away,
without restarting. A double click on a `.termiau` in Finder — where it shows with
TermIAu's plugin icon — does the same, after asking.

```json
{
  "id": "termiau.radio", "name": "Radio", "version": "1.0.0",
  "main": "main.js", "style": "style.css", "icon": "icon.svg",
  "activationEvents": ["onStartupFinished"],
  "contributes": {
    "regions": [{ "region": "statusBar", "id": "radio", "priority": 100 }],
    "commands": [{ "id": "toggle", "title": { "en": "Play / Pause", "pt": "Tocar / Pausar" },
                   "keybinding": "CmdOrCtrl+Shift+P", "menu": { "en": "Radio", "pt": "Rádio" } }]
  }
}
```

The module exports `activate(ctx)` (and optionally `deactivate()`). `ctx` gives it
its footer slot, command handlers, storage scoped to the plugin, the app's footer
button, dialog shell and marquee, and the language — see
[`src/plugins/api.ts`](src/plugins/api.ts). Each `menu` becomes a submenu in the menu
bar with the command's shortcut, and `icon` is what the Plugins tab shows (a plugin
without one gets the default plugin icon). Rust builds the menu (`src-tauri/src/plugins.rs`) and
serves the plugin's files over `termiau-plugin://`.

A plugin can also declare **settings** (`contributes.configuration`, like VS Code's):
each one a `key`, a localized `title` and `description`, and a `type` — `enum` (with
`options`), `boolean` or `number` (with `min` and `max`) — with a `default`. The Plugins tab draws them under the
plugin, and the plugin reads them with `ctx.settings.get(key)` and hears changes with
`ctx.settings.onChange`. Claude Context uses them for its limits.

The regions so far are the footer (`statusBar`, at the left corner with `"alignment":
"start"`, after the task pills with `"left"`, or against the right end) and
`panelHeader`, a slot on the bar of every terminal panel — the plugin's
`ctx.regions.panelHeader(id, (panel, el) => …)` draws it in each one, the open ones
and the ones opened later.

A plugin can **depend** on others (`"dependencies": ["termiau.claude"]`): they are
activated before it, what their `activate` returns is their API
(`ctx.plugins.api(id)`), and the marketplace installs them along with it. When one
is missing or off, the plugin doesn't load and the Plugins tab says why.

A plugin runs inside the app's webview, with the app's access: installing one is
trusting it. What the app does guarantee is that a broken one doesn't take it
down — the error shows in the Plugins tab.

The plugins that live in this repository are built and packaged with
`npm run plugin:<name>`, which writes `dist-plugins/<id>-<version>.termiau`.

### The marketplace

**Preferences ▸ Plugins ▸ Open the marketplace** shows the catalog: a card per
plugin, with its icon, author, version and description, a search, and Install,
Update or Installed. Installing checks the package against the catalog's size and
sha256 before unpacking it.

The catalog is local for now: `npm run marketplace` packages every plugin in
`plugins/` into `dist-marketplace/` (`index.json`, `packages/`, `icons/`), and the
app bundles that folder as a resource — `beforeDevCommand` and `beforeBuildCommand`
run it, and `cargo test` on a fresh clone needs it once. Its shape is already the
one an online catalog will have: the paths in `index.json` become URLs.

### Verified plugins and native code

A plugin may ship **native binaries** (`"binaries"` in the manifest) that the app
runs as child processes and speaks to with JSON lines over stdin/stdout — that is
how the Claude Code plugin brings its engine without it being part of the app. Native code runs
with your full rights, so the app only installs such a plugin when it is **signed by
a publisher it trusts** (today: TermIAu): an Ed25519 signature (`termiau.sig`) over
the sha256 of every file in the package. The check runs again before each launch, so
a binary changed on disk after install doesn't start. JS-only plugins may stay
unsigned; signed ones show a **Verified** badge.

The private key lives outside the repository (`~/.termiau-signing/ed25519.pem`,
created by `scripts/signing-key.sh`); `npm run plugin:<name>` signs with it, and the
public key is in `src-tauri/src/signing.rs`.

### The radio

The footer radio is the first plugin ([`plugins/radio/`](plugins/radio/README.md)):
257 internet stations, a spectrum analyser and `⌘⇧P`. `npm run plugin:radio`
builds the package, and the Plugins tab installs it.

## Shortcuts

| Shortcut | Action |
| --- | --- |
| `⌘T` | New tab |
| `⌘D` / `⌘⇧D` | Split the panel to the side / below |
| `⌘W` | Close the focused panel (the last one closes the tab) |
| `⌘1`…`⌘9` | Go to tab *n* — `⌘9` goes to the last one |
| `` ⌘` `` | Go to the diff tab |
| `⌘⇧[` / `⌘⇧]` | Previous / next tab |
| `⌘⌥←↑→↓` | Move focus to the neighbouring panel |
| `⌘⇧A` | Go to the panel where Claude is waiting for an answer |
| `⌘K` | Clear the screen |
| `⌘⇧V` | Paste the **path** of the file on the clipboard |
| `⌘⇧P` | Play or pause the radio (with the Radio plugin) |
| `⌘⇧K` | Compact the Claude conversation (with the Claude Context plugin) |

Everything else goes straight to the shell. `⌥` composes characters as in the rest
of macOS — `⌥C` gives `ç`, `⌥E`+`E` gives `é` —, so it doesn't work as Meta: `⌥F`
and `⌥B` don't move by word. The navigation keys still work, because they don't go
through composition: `⌥←` and `⌥→` move by word, `⌥⌫` deletes the previous word.

## Files

Dragging a file or a folder from Finder and dropping it on a panel writes its
path on the line — in the panel under the pointer, which also takes the keyboard.
Dropping several at once writes them all, separated by spaces. What comes out is
backslash-escaped, as in Terminal.app: `/Users/me/My\ Documents`. Accents and
emoji pass through intact — high bytes aren't special to the shell.

`⌘⇧V` does the same with whatever is on the clipboard. It's a separate key from
`⌘V` because Finder puts two things on the clipboard when you copy a file — the
file and its *name*, with no folder at all — and the name is what `⌘V` pastes.
With no file on the clipboard, `⌘⇧V` pastes the text and acts like `⌘V`.

In both cases the text goes in through xterm's paste path, not through
`pty_write`: that's what wraps it in *bracketed paste* when the program on the
other side asked for it — which is what makes the path reach Claude Code and vim
whole, instead of character by character.

## Structure

```
index.html            window shell
src/
  main.ts             xterm, addons and the bridge to the Tauri commands
  style.css           window theme and the paw cursor
  ui.ts               footer button, dialog shell and marquee, shared with plugins
  plugins/            the plugin host, its API (api.ts) and manifest rules
plugins/
  radio/              the Radio plugin (npm run plugin:radio)
  claude/             the Claude Code plugin: the hook (hook/), its engine (engine/) and the sessions
  claude-chat/        chat mode, over the terminal
  claude-ask/         asking Claude about a passage of the diff tab
hooks/
  termiau             the `termiau` CLI (view, progress), installed in ~/.termiau/bin
scripts/
  install.sh          bundles the app and puts it in /Applications (dev or prod channel)
  package-plugin.sh   builds a plugin from plugins/<name> into a .termiau package
  plugin-icon.sh      rebuilds icons/plugin.icns (the .termiau Finder icon) from plugin.svg
  build-marketplace.mjs  packages every plugin into dist-marketplace/, the local catalog
src-tauri/
  src/lib.rs          PTY, commands, menu and the socket
  src/plugins.rs      installed plugins: list, install, menu, termiau-plugin://
  src/marketplace.rs  the catalog: read it, check a package's sha256, install
  src/main.rs         entrypoint
  src/clipboard.rs    the macOS clipboard, for ⌘⇧V
  src/plugin_process.rs  the verified plugins' native processes (stdin/stdout JSON)
  src/signing.rs      Ed25519 signatures: which plugins may ship native code
  tauri.conf.json     window, bundle and build
  tauri.dev.conf.json the same with another name and identifier, for the dev channel
  capabilities/       permissions for the main window
```

## Tauri commands

| Command | What for |
| --- | --- |
| `pty_spawn { rows, cols }` | Opens the PTY and starts the login shell (killing the previous one) |
| `pty_write { data }` | Sends what was typed to the shell |
| `pty_resize { rows, cols }` | Resizes the grid and fires `SIGWINCH` |
| `js_log { msg }` | Sends webview errors to the process's stderr |
| `clipboard_paste` | Reads the clipboard: the file paths, or the text |

Events in the other direction: `pty://data` (output in base64) and `pty://exit`.

## Features

**Terminal**
- Your real login shell (`$SHELL -l`) on a PTY, drawn by xterm.js, with a cat-paw cursor
- Tabs and split panels (side / below), focus moved with `⌘⌥` + arrows, a panel
  maximized and restored with `⌘⇧↩`, and a ✕ on the bar to close it when split
- Preferences (`⌘,`) float over any tab
- Reopen the closed tab (`⌘⇧T`), and optionally restore the tabs on launch, in the
  same folders, resuming their Claude sessions
- Files dropped from Finder become escaped paths on the line; `⌘⇧V` pastes the path
  of the copied file
- File references in the output (`src/main.ts:848`) open in the built-in viewer
- Quitting asks first
- Interface in Portuguese or English, following the macOS language

**Claude Code** (through the hook)
- Each tab shows its Claude session's state — working, waiting for you —, the Dock
  badge counts the ones waiting, and `⌘⇧A` jumps to the panel that's waiting. The
  waiting signals blink unless **Preferences ▸ Attention** turns blinking off
- With the Claude plugins: the session's context, model and effort on the panel bar —
  click to compact (`⌘⇧K`), switch model or switch effort —, the context turning
  yellow, then red with a pulsing border, auto-compact, and the usage of the 5-hour
  and 7-day limits in the footer
- Chat mode (`⌘⇧C`, the Claude Chat plugin): the conversation read from the transcript, with Claude's
  questions and permission requests answered by click, `/` commands, pasted images,
  resuming earlier sessions and each edit's diff
- Jump to your previous / next message in the terminal (`⌘⇧↑` / `⌘⇧↓`)
- Set up from the menu: **Claude Code ▸ Connect to Claude Code…** (Claude Code plugin)

**File viewer**
- Opens a file beside, below or over the terminal (`⌘⇧O`), with Markdown rendered or
  as source, and **Open in editor** with a configurable command
- Several files open as tabs, each with its own close button; switching tabs keeps
  unsaved edits
- Simple edit mode (eye / pencil): line numbers, syntax colors, save with `⌘S`, and a
  save / discard / cancel prompt when leaving with unsaved changes; the scroll stays
  put between reading and editing
- Markdown checkboxes toggle with a click and are saved to the file; Mermaid diagrams
  render with zoom and pan; code blocks get a copy button
- Images (PNG, JPG, GIF, WebP, SVG…) open in the viewer, fitted or at real size
- File explorer drawer that slides over the terminal and closes on an outside click,
  or pinned open to share the space with the viewer
- `termiau view <file>[:line]` opens it from the shell; `--ref` shows the file as it is
  in a branch or commit

**Diff tab** (pinned, `` ⌘` ``)
- Three review scopes: the whole branch against a target branch, incremental since
  the last complete review, and what's about to be committed
- Unified or side by side, with syntax highlighting (Shiki); images compared side by
  side, toggling, with a slider or by pixel difference
- Mark files as reviewed (which stages them), stage and unstage files, folders or
  everything, and commit from the sidebar
- Bookmarks (review comments) on lines or selections, which know whether the code
  changed since; copy one or all as a reference to paste into a prompt
- Ask Claude about a snippet (the Claude in the Diff plugin) — default model, Haiku
  or Opus, optionally with a session as context —, let it edit the files and undo what
  it changed, and turn the conversation into a bookmark
- Warns when the repository gets new commits

**Play button**
- Runs `.vscode/launch.json` configurations — Dart, Flutter (with hot reload and hot
  restart buttons), Node, Python, Go — in the app's terminal, with the
  `preLaunchTask` from `tasks.json`, stop and restart

**Plugins**
- VS Code–style plugins by region, installed from `.termiau` packages in
  Preferences ▸ Plugins, with their own menu items and shortcuts
- **Radio** (plugin): 257 internet stations across 15 genres, with a picker, a
  spectrum analyser, a five-step volume ring and `⌘⇧P` to play or pause; closed
  while playing, it opens playing

</details>

<details>
<summary><b>Português</b></summary>

Emulador de terminal de desktop, com uma patinha de gato no lugar do cursor.

Uma janela [Tauri 2](https://tauri.app) desenha a grade com [xterm.js](https://xtermjs.org)
e o Rust cuida do PTY de verdade — o shell que roda ali dentro é o seu (`$SHELL -l`),
com o seu `.zshrc`, o seu prompt e as suas TUIs.

## Como funciona

```
┌─ webview (TypeScript) ──────────┐        ┌─ Rust (src-tauri) ──────────────┐
│  xterm.js                       │        │  portable-pty                   │
│    onData ──── invoke pty_write ───────► │  ── writer.write_all ─► shell   │
│    write  ◄─── evento pty://data ◄────── │  ◄─ thread de leitura ─ shell   │
│    ResizeObserver ── pty_resize ───────► │  ── master.resize ──► SIGWINCH  │
└─────────────────────────────────┘        └─────────────────────────────────┘
```

Alguns detalhes que não são óbvios no código:

- **Saída em base64.** Um chunk de 8 KB pode cortar um caractere UTF-8 no meio;
  os bytes vão codificados e o front remonta antes de entregar ao xterm.
- **Ambiente limpo.** O shell não herda o ambiente de quem abriu o app
  (`npm_*`, `CARGO_*`, `ITERM_SESSION_ID`…). Só passa uma lista curta
  (`HOME`, `SHELL`, `SSH_AUTH_SOCK`, locale…) e um `PATH` mínimo de bootstrap —
  o login shell reconstrói o resto.
- **Gerações de PTY.** Cada shell recebe um número de série. A cada reload da
  webview o shell anterior é morto, e a thread que espera por ele só anuncia
  `[processo encerrado]` se ainda for o shell vigente — senão a sessão nova
  nasceria com o aviso de morte da antiga.
- **Resize com debounce.** O `fit()` roda a cada frame para o desenho acompanhar
  o arrasto, mas o `SIGWINCH` sai uma vez só, 80 ms depois que o arrasto para.
  Sem isso o prompt se redesenha ~45 vezes durante um arrasto.
- **Cursor patinha.** Feito em CSS puro sobre `.xterm-cursor-block`, com um SVG
  inline como `background`. Depende do renderer DOM do xterm — carregar os addons
  `webgl`/`canvas` faria o cursor voltar a ser um bloco.

## Requisitos

- Node 20+ e npm
- Rust estável (`rustup`) — o projeto foi construído com cargo 1.97
- Pré-requisitos do Tauri 2 para o seu sistema ([guia oficial](https://tauri.app/start/prerequisites/))
- Fonte **MesloLGS NF** instalada, se você usa Powerlevel10k ou outro prompt com
  glifos de Nerd Font. Sem ela o prompt vira caixinhas.

Desenvolvido e testado no macOS. O código do PTY é portátil, mas nada além do
macOS foi exercitado ainda.

## Rodando

```bash
npm install
npm run tauri dev
```

Para gerar o app empacotado:

```bash
npm run tauri build
```

Os artefatos saem em `src-tauri/target/release/bundle/`.

## Ligando os avisos do Claude

As abas mostram em que pé está cada sessão do Claude Code — trabalhando,
esperando você —, e os plugins do Claude (abaixo) mostram o contexto, o modelo e o
esforço da sessão na barra do painel e o uso dos limites de 5h e de 7 dias no
rodapé. Tudo isso só chega pelo socket do app, e quem escreve ali é um hook, que
precisa estar registrado no `settings.json` do Claude Code. Pelo app, é
**Claude Code ▸ Ligar ao Claude Code…** (o menu do plugin Claude Code); pelo repo:

```bash
./plugins/claude/hook/install.sh
```

O script copia o `termiau-event.sh` para `~/.claude/hooks/` (e não aponta para
o repo: ele pode estar num volume que não está montado quando o Claude roda),
registra os eventos que o app trata — `SessionStart`, `UserPromptSubmit`,
`PermissionRequest`, `Notification`, `Stop`, `SessionEnd` e os de ferramenta
(`PreToolUse`, `PostToolUse`, `PostToolUseFailure`) — e guarda um backup do
settings anterior. Rodar de novo é inofensivo.

### O contexto e o uso

O contexto e o uso não vêm dos eventos, e sim da status line: o Claude Code
manda para ela, a cada atualização, um JSON com a janela de contexto e os
limites. Por isso a `statusLine` do `settings.json` também tem que passar pelo
hook, com o argumento `status`:

```json
"statusLine": {
  "type": "command",
  "command": "bash ~/.claude/hooks/termiau-event.sh status",
  "padding": 0
}
```

O instalador só põe essa linha se ainda não houver uma status line sua — uma
que já existe fica, e aí o contexto e o uso não chegam. Para trocar, edite o
`settings.json` como acima. A sua antiga não se perde: se ela estiver em
`~/.claude/statusline-command.sh`, o hook a usa fora do TermIAu (iTerm2, VS
Code); dentro dele a linha fica vazia, porque o app já mostra tudo.

Sem o hook instalado o app sobe normal, só calado: as abas não mostram estado
do Claude, a barra não mostra o contexto, o rodapé não mostra o uso e o badge
do Dock fica vazio.

### Os plugins do Claude

O que mostra o estado do Claude além das abas vem em plugins pequenos, todos no
marketplace, que dependem de um núcleo:

- **Claude Code** (`termiau.claude`) — a ligação: instala e atualiza o hook,
  acompanha a sessão de cada painel pelos eventos e pela status line, e passa isso
  aos outros pela API dele. Não desenha nada; o hook dele fala com ele pelo socket
  do app, que entrega cada mensagem ao plugin que ela nomeia.
- **Claude Context** (`termiau.claude-context`) — a pílula com o contexto da sessão
  na barra de cada painel: amarela, depois vermelha com a borda do painel pulsando;
  clicar ou `⌘⇧K` compacta, e o auto-compact pode ir sozinho. Os limites são as
  configurações dele (Preferências ▸ Plugins).
- **Claude Usage** (`termiau.claude-usage`) — a sessão de 5 horas e a semana no canto
  esquerdo do rodapé, com o tempo restante e o ritmo.
- **Claude Model** (`termiau.claude-model`) — o modelo e o esforço da sessão na barra
  de cada painel, a um clique do `/model` e do `/effort`.
- **Claude Chat** (`termiau.claude-chat`) — o modo chat, por cima do terminal.
- **Claude in the Diff** (`termiau.claude-ask`) — perguntar ao Claude sobre um trecho
  da aba de diff, carregado dentro daquela página (`ctx.differ.extend`).

Instalar qualquer um deles traz o Claude Code junto.

## Plugins

O TermIAu aceita plugins, no molde das extensões do VS Code mas organizados por
**regiões**: as áreas da janela — o rodapé e, mais adiante, a barra lateral, as abas
e as preferências — são independentes, cada uma é do app, e o plugin declara um
lugar numa delas e desenha só ali dentro.

Um plugin é um pacote `.termiau`: um zip com o manifesto `termiau.json` na raiz e o
módulo ES que ele aponta. **Preferências (⌘,) ▸ Plugins ▸ Instalar de arquivo…**
desempacota em `~/.termiau/plugins/<id>/`; a mesma aba liga, desliga e remove cada
um, e o rodapé, o menu e a lista de atalhos acompanham na hora, sem reiniciar. Dois
cliques num `.termiau` no Finder — onde ele aparece com o ícone de plugin do
TermIAu — fazem o mesmo, depois de perguntar.

O módulo exporta `activate(ctx)` (e, se quiser, `deactivate()`). O `ctx` dá o lugar
no rodapé, os comandos, um armazenamento só do plugin, o botão do rodapé, a casca de
diálogo e o letreiro do app, e o idioma — veja
[`src/plugins/api.ts`](src/plugins/api.ts). Cada `menu` vira um submenu na barra de
menus com o atalho do comando, e o `icon` é o que a aba Plugins mostra (plugin sem
ícone ganha o ícone padrão de plugin). Quem monta o menu é o Rust (`src-tauri/src/plugins.rs`), que
também serve os arquivos do plugin por `termiau-plugin://`.

Um plugin também pode declarar **configurações** (`contributes.configuration`, como
no VS Code): cada uma com `key`, `title` e `description` traduzidos e um `type` —
`enum` (com `options`), `boolean` ou `number` (com `min` e `max`) — com um `default`.
A aba Plugins desenha os campos embaixo do plugin, e o plugin lê com
`ctx.settings.get(key)` e ouve as mudanças com `ctx.settings.onChange`. O Claude
Context usa para os limites dele.

As regiões até aqui são o rodapé (`statusBar`, no canto esquerdo com `"alignment":
"start"`, depois das pílulas de tarefa com `"left"`, ou encostado na direita) e
`panelHeader`, um lugar na barra de cada painel de terminal — o
`ctx.regions.panelHeader(id, (panel, el) => …)` do plugin desenha em cada um, nos
abertos e nos que abrirem depois.

Um plugin pode **depender** de outros (`"dependencies": ["termiau.claude"]`): eles
ativam antes, o que o `activate` deles devolve é a API deles (`ctx.plugins.api(id)`),
e o marketplace instala junto. Se um falta ou está desligado, o plugin não carrega e
a aba Plugins diz por quê.

O plugin roda dentro da webview do app, com o acesso do app: instalar é confiar. O
que o app garante é que um plugin quebrado não o derruba — o erro aparece na aba
Plugins.

Os plugins que moram neste repositório são construídos e empacotados com
`npm run plugin:<nome>`, que grava `dist-plugins/<id>-<versão>.termiau`.

### O marketplace

**Preferências ▸ Plugins ▸ Abrir o marketplace** mostra o catálogo: um card por
plugin, com ícone, autor, versão e descrição, uma busca, e Instalar, Atualizar ou
Instalado. Instalar confere o pacote contra o tamanho e o sha256 do catálogo antes
de desempacotar.

Por enquanto o catálogo é local: `npm run marketplace` empacota cada plugin de
`plugins/` em `dist-marketplace/` (`index.json`, `packages/`, `icons/`), e o app leva
essa pasta como recurso — o `beforeDevCommand` e o `beforeBuildCommand` rodam o
script, e o `cargo test` num clone novo precisa dela uma vez. O formato já é o de um
catálogo online: os caminhos do `index.json` viram URLs.

### Plugins verificados e código nativo

Um plugin pode trazer **binários nativos** (`"binaries"` no manifesto), que o app roda
como processos filhos e com quem conversa por linhas de JSON no stdin/stdout — é assim
que o plugin Claude Code traz o motor dele sem ele fazer parte do app. Código nativo roda com
todos os seus direitos, então o app só instala um plugin desses **assinado por um
publicador em que confia** (hoje: o TermIAu): uma assinatura Ed25519 (`termiau.sig`)
sobre o sha256 de cada arquivo do pacote. A conferência roda de novo antes de cada
execução, então um binário trocado no disco depois de instalado não sobe. Plugins só
de JS podem ficar sem assinatura; os assinados ganham o selo **Verificado**.

A chave privada mora fora do repositório (`~/.termiau-signing/ed25519.pem`, criada
pelo `scripts/signing-key.sh`); o `npm run plugin:<nome>` assina com ela, e a chave
pública fica em `src-tauri/src/signing.rs`.

### A rádio

A rádio do rodapé é o primeiro plugin ([`plugins/radio/`](plugins/radio/README.md)):
257 rádios de internet, analisador de espectro e `⌘⇧P`. O `npm run plugin:radio`
gera o pacote, e a aba Plugins instala.

## Atalhos

| Atalho | Ação |
| --- | --- |
| `⌘T` | Nova aba |
| `⌘D` / `⌘⇧D` | Divide o painel ao lado / abaixo |
| `⌘W` | Fecha o painel em foco (o último fecha a aba) |
| `⌘1`…`⌘9` | Vai para a aba *n* — `⌘9` vai para a última |
| `` ⌘` `` | Vai para a aba do diff |
| `⌘⇧[` / `⌘⇧]` | Aba anterior / próxima |
| `⌘⌥←↑→↓` | Move o foco para o painel vizinho |
| `⌘⇧A` | Vai para o painel onde o Claude espera resposta |
| `⌘K` | Limpa a tela |
| `⌘⇧V` | Cola o **caminho** do arquivo que está na área de transferência |
| `⌘⇧P` | Toca ou pausa a rádio (com o plugin Rádio) |
| `⌘⇧K` | Compacta a conversa do Claude (com o plugin Claude Context) |

Todo o resto vai direto para o shell. `⌥` compõe caractere como no resto do
macOS — `⌥C` dá `ç`, `⌥E`+`E` dá `é` —, então não serve de Meta: `⌥F` e `⌥B`
não andam palavra. As teclas de navegação continuam, porque não passam pela
composição: `⌥←` e `⌥→` andam palavra, `⌥⌫` apaga a palavra anterior.

## Arquivos

Arrastar um arquivo ou uma pasta do Finder e soltar sobre um painel escreve o
caminho dele na linha — no painel sob o ponteiro, que também recebe o teclado.
Soltar vários de uma vez escreve os vários, separados por espaço. O que sai é
escapado com contrabarra, como no Terminal.app: `/Users/eu/Meus\ Documentos`.
Acento e emoji passam inteiros — byte alto não é especial para o shell.

O `⌘⇧V` faz o mesmo com o que estiver na área de transferência. É uma tecla
separada do `⌘V` porque o Finder põe duas coisas na área quando você copia um
arquivo — o arquivo e o *nome* dele, sem pasta nenhuma — e é o nome que o `⌘V`
cola. Sem arquivo na área, o `⌘⇧V` cola o texto e age como um `⌘V`.

Nos dois casos o texto entra pelo caminho de colagem do xterm, não por
`pty_write`: é ele que embrulha em *bracketed paste* quando o programa do outro
lado pediu — é o que faz o caminho chegar inteiro no Claude Code e no vim, em
vez de caractere a caractere.

## Estrutura

```
index.html            casca da janela
src/
  main.ts             xterm, addons e a ponte com os comandos do Tauri
  style.css           tema da janela e o cursor patinha
  ui.ts               botão do rodapé, casca de diálogo e letreiro, divididos com os plugins
  plugins/            o host de plugins, a API (api.ts) e as regras do manifesto
plugins/
  radio/              o plugin Rádio (npm run plugin:radio)
  claude/             o plugin Claude Code: o hook (hook/), o engine (engine/) e as sessões
  claude-chat/        o modo chat, por cima do terminal
  claude-ask/         perguntar ao Claude sobre um trecho da aba de diff
hooks/
  termiau             o CLI `termiau` (view, progress), instalado em ~/.termiau/bin
scripts/
  install.sh          empacota e põe em /Applications (canal dev ou prod)
  package-plugin.sh   constrói um plugin de plugins/<nome> num pacote .termiau
  plugin-icon.sh      refaz icons/plugin.icns (o ícone do .termiau no Finder) do plugin.svg
  build-marketplace.mjs  empacota cada plugin em dist-marketplace/, o catálogo local
src-tauri/
  src/lib.rs          PTY, comandos, menu e o socket
  src/plugins.rs      plugins instalados: listar, instalar, menu, termiau-plugin://
  src/marketplace.rs  o catálogo: ler, conferir o sha256 do pacote, instalar
  src/main.rs         entrypoint
  src/clipboard.rs    a área de transferência do macOS, para o ⌘⇧V
  src/plugin_process.rs  os processos nativos dos plugins verificados (JSON por stdin/stdout)
  src/signing.rs      assinaturas Ed25519: que plugins podem trazer código nativo
  tauri.conf.json     janela, bundle e build
  tauri.dev.conf.json o mesmo com outro nome e identificador, para o canal dev
  capabilities/       permissões da janela principal
```

## Comandos do Tauri

| Comando | Para quê |
| --- | --- |
| `pty_spawn { rows, cols }` | Abre o PTY e sobe o login shell (matando o anterior) |
| `pty_write { data }` | Manda o que foi digitado para o shell |
| `pty_resize { rows, cols }` | Reajusta a grade e dispara `SIGWINCH` |
| `js_log { msg }` | Joga erros da webview no stderr do processo |
| `clipboard_paste` | Lê a área de transferência: os caminhos dos arquivos, ou o texto |

Eventos na direção contrária: `pty://data` (saída em base64) e `pty://exit`.

## Funcionalidades

**Terminal**
- O seu login shell de verdade (`$SHELL -l`) num PTY, desenhado pelo xterm.js, com o
  cursor patinha
- Abas e painéis divididos (ao lado / abaixo), foco movido com `⌘⌥` + setas, painel
  maximizado e recolhido com `⌘⇧↩`, e um ✕ na barra para fechá-lo quando dividido
- Preferências (`⌘,`) flutuam por cima de qualquer aba
- Reabrir a aba fechada (`⌘⇧T`); ao abrir, as abas voltam nas mesmas pastas,
  retomando as sessões do Claude
- Arquivos soltos do Finder viram caminhos escapados na linha; `⌘⇧V` cola o caminho
  do arquivo copiado
- Referências de arquivo na saída (`src/main.ts:848`) abrem no visor embutido
- Sair pergunta antes
- Interface em português ou inglês, seguindo o idioma do macOS

**Claude Code** (pelo hook)
- Cada aba mostra o estado da sessão do Claude — trabalhando, esperando você —, o
  badge do Dock conta as que esperam e `⌘⇧A` leva ao painel que espera. Os sinais de
  espera piscam, a menos que **Preferências ▸ Atenção** desligue o piscar
- Com os plugins do Claude: o contexto, o modelo e o esforço da sessão na barra do
  painel — clique para compactar (`⌘⇧K`), trocar o modelo ou trocar o esforço —, o
  contexto ficando amarelo, depois vermelho com a borda pulsando, o auto-compact, e o
  uso dos limites de 5 horas e de 7 dias no rodapé
- Modo chat (`⌘⇧C`, plugin Claude Chat): a conversa lida do transcript, com as perguntas e os pedidos de
  permissão do Claude respondidos num clique, comandos `/`, imagens coladas, retomada
  de sessões anteriores e o diff de cada edição
- Ir para a sua mensagem anterior / seguinte no terminal (`⌘⇧↑` / `⌘⇧↓`)
- Instalação pelo menu: **Claude Code ▸ Ligar ao Claude Code…** (plugin Claude Code)

**Visor de arquivos**
- Abre um arquivo ao lado, abaixo ou por cima do terminal (`⌘⇧O`), com Markdown
  renderizado ou em fonte, e **Abrir no editor** com um comando configurável
- Vários arquivos abertos como abas, cada uma com o seu botão de fechar; trocar de aba
  mantém as edições não salvas
- Modo de edição simples (olho / lápis): números de linha, cores de sintaxe, salvar
  com `⌘S` e um aviso de salvar / descartar / cancelar ao sair com alterações; a
  rolagem fica onde estava entre ler e editar
- Checkboxes do Markdown marcam e desmarcam num clique e são salvas no arquivo;
  diagramas Mermaid renderizados com zoom e arrastar; blocos de código com botão de
  copiar
- Imagens (PNG, JPG, GIF, WebP, SVG…) abrem no visor, ajustadas ou no tamanho real
- Explorador de arquivos em gaveta, que abre por cima do terminal e fecha ao clicar
  fora, ou fixado com o alfinete para dividir o espaço com o visor
- `termiau view <arquivo>[:linha]` abre pelo shell; `--ref` mostra o arquivo como está
  numa branch ou num commit

**Aba do diff** (presa, `` ⌘` ``)
- Três escopos de revisão: a branch inteira contra uma branch alvo, incremental desde
  a última revisão completa e o que está para ser commitado
- Unificado ou lado a lado, com realce de sintaxe (Shiki); imagens comparadas lado a
  lado, alternando, com divisória deslizante ou pela diferença de pixels
- Marcar arquivos como revisados (o que os põe no índice), pôr e tirar do índice
  arquivos, pastas ou tudo, e commitar pela barra lateral
- Marcadores (comentários de revisão) em linhas ou seleções, que sabem se o código
  mudou depois; copiar um ou todos como referência para colar num prompt
- Perguntar ao Claude sobre um trecho (plugin Claude in the Diff) — modelo padrão,
  Haiku ou Opus, com uma sessão como contexto se quiser —, deixar que ele edite os
  arquivos e desfazer o que mudou, e transformar a conversa num marcador
- Avisa quando o repositório recebe commits novos

**Botão de play**
- Roda as configurações do `.vscode/launch.json` — Dart, Flutter (com botões de hot
  reload e hot restart), Node, Python, Go — no terminal do app, com a `preLaunchTask`
  do `tasks.json`, parar e reiniciar

**Plugins**
- Plugins no estilo do VS Code, por região, instalados de pacotes `.termiau` em
  Preferências ▸ Plugins, com itens de menu e atalhos próprios
- **Rádio** (plugin): 257 rádios de internet em 15 gêneros, com seletor, analisador
  de espectro, anel de volume de cinco estágios e `⌘⇧P` para tocar ou pausar; fechada
  tocando, abre tocando

</details>
