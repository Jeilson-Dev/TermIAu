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
you —, the panel bar shows the session's context and the footer the usage of
the 5h and 7-day limits. All of this only arrives through the app's socket, and
what writes there is a hook, which has to be registered in Claude Code's
`settings.json`. From the app, it's **TermIAu ▸ Connect to Claude Code…**; from the repo:

```bash
./hooks/instalar.sh
```

The script copies `termiau-evento.sh` to `~/.claude/hooks/` (rather than pointing
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
  "command": "bash ~/.claude/hooks/termiau-evento.sh status",
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

## The radio

In the right corner of the footer, across from the listening wave: ☰ for the list, ▶,
the next-station arrow, the volume and the name of what's playing. There are **257
stations across 15 genres** — underground electronic, freeform, jazz, ambient, campus,
chiptune, world, metal —, played by an `<audio>` in the page itself.

The list comes from
[recommended-radio-streams](https://github.com/deroverda/recommended-radio-streams),
a CC0 curation. CC0 covers the **list**; each station has its own terms.
The original 430 went through three filters, and each one was **measured**, not
assumed:

1. **`https` only.** From a `tauri://` page WebKit refuses an `http` stream as
   mixed content — `NotSupportedError` on `play()`. That cuts 113.
2. **Only those that responded** to a probe that actually played them in a WebView: 55
   gave an error, a refusal or silence.
3. The 257 left are in, tagged by what Web Audio can see.

> Before this the radio was SomaFM, and before that YouTube live streams.
>
> YouTube played in `npm run app:dev` and **didn't play in the installed app**: in
> release the window runs at `tauri://localhost`, and from that origin YouTube refuses
> the embed with error 153 — the player opens, answers `onReady` and stays mute. The
> scheme isn't our choice: on macOS Tauri always serves the window over
> `tauri://`, and `useHttpsScheme` only applies to Windows and Android.
>
> SomaFM left over licensing, not technology. Their terms, updated on
> September 4, 2026, say they **can't authorize third-party clients, not even
> non-profit ones**, and that now-playing polling is grounds for blocking. It played
> perfectly; it couldn't stay.

### The two audio paths

There are **two** `<audio>` elements, not one. A source from another origin that
doesn't allow CORS enters Web Audio zeroed out — and since the graph is what talks
to the speaker, it would play in silence.

The header isn't enough to tell which is which: of the 312 probed, **249 sent
`Access-Control-Allow-Origin` and only 56 deliver real samples**. That's why the
tag in `estacoes.ts` came from real playback, not from a `curl`.

- **56 stations** go through `audioGrafo`: `crossOrigin="anonymous"` → analyser →
  gain → speaker. Spectrum and volume ring.
- **201 stations** go through `audioDireto`: outside the graph, volume through the
  element's `volume`, display frozen. In the picker they carry the "no spectrum" tag.

The tag ages — servers change their configuration. Three seconds after starting,
if the station came in through the graph and the graph received nothing, it is
demoted and restarts on the direct path: playing mute is worse than playing
without a display.

No network before ▶ (`preload="none"`): without pressing play the footer comes up
mute and the app talks to no one. And everything ▶ needs happens inside the click
gesture, with no `await` in between — WebKit only unlocks audio under a gesture of
yours, and the gesture doesn't survive a wait. With an `await ctx.resume()` before
`play()`, the play lands on the other side of the click and is refused, with a
`NotSupportedError` that on top of that doesn't look like what it is.

### Volume and name

The volume is a **five-stage ring**: mute, 25, 50, 75, 100. A click goes up one
step and, after full, back to mute; the ring lights up clockwise in the same
purple as ▶, and on mute it goes dark and a slash appears. It used to be a slider,
and a slider wants a long target for the pointer to travel — long is what a 30px
strip doesn't have. This way the whole footer fits in 219px.

In the graph the volume lives in a `GainNode`, not in the `<audio>`'s `volume`:
once the element is routed into Web Audio, WebKit stops applying that attribute — it
accepts the value, `a.volume` reads what you set and the sound comes out the same.
With `volume = 0` the samples stay full. Outside the graph the attribute works again,
and it's what the direct path uses.

The name strip has a **fixed width** of 100px. With a max width it shrank and
grew with each new station, and the buttons and the volume, which come before it
on the same line, jumped from side to side. What doesn't fit scrolls inside: it
moves to the end at ~33 px/s, waits with the tail of the text in view, jumps back
to the start at once and pauses thirty seconds before moving again.

There's no "now playing": community radio has no now-playing API, and reading
each station's `icy-name` would take a second connection to its server just for
that — which doubles the bandwidth taken from a small station.

### The spectrum

Ten columns cut into segments, like an LED display, with a peak that hangs in the
air and falls on its own. The heights are **measured**: a 2048-point FFT, ten
octave-spaced bands between 40 Hz and 16 kHz, each column with the highest value
in its band.

Each band's scale **floats**. A fixed ceiling doesn't exist: measured, the lowest
band lives at -45 dB and the highest at -77, and that gap changes with the genre —
with a fixed window the columns all sit at the top. So each band carries its own
ceiling, which rises on peaks and falls ~1.2 dB/s, and the display covers the 16 dB
below it. That gives three segments in the body of the music and five on peaks. The
ceiling has a floor (-58 dB) because without it the silence between tracks would
become infinite gain and the hiss would climb all the way up.

The values come in raw dB (`getFloatFrequencyData`): the byte from
`getByteFrequencyData` already arrives squeezed into a fixed -100 to -30 dB window,
and that is exactly the window that couldn't be fixed. The bands also can't pile
up — at 2048 points the resolution is 23 Hz, and at 512 the first three all fell
into the first two bins, one of them the DC component, which isn't sound and
never moves.

The analyser comes **before** the gain, to measure pre-fader like any mixing desk:
at low volume the columns keep counting what's playing instead of dying along
with the sound.

### The picker

The footer's ☰ or **Radio ▸ Stations…** opens the list, with the genre next to
each name — two hundred and fifty names don't say what they play. The 56 with
spectrum come first; the others carry the "no spectrum" tag. Clicking a name puts
the station on air; the one playing is in purple and scrolls into view on its own
when the list opens. `esc`, the ✕ or a click on the dark area close it.

Rebuilding the list means running the probe again: small stations go off air, and
the picker warns when one doesn't open.

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
| `⌘E` | Turn listening on and off (speak instead of typing) |
| `⌘⇧P` | Play or pause the radio |

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
hooks/
  termiau-evento.sh   the hook: sends Claude's event to the app's socket
  instalar.sh         registers the hook in Claude Code's settings.json
scripts/
  instalar.sh         bundles the app and puts it in /Applications (dev or prod channel)
src-tauri/
  src/lib.rs          PTY, commands, menu and the hooks socket
  src/main.rs         entrypoint
  src/area.rs         the macOS clipboard, for ⌘⇧V
  src/escuta/         local transcription: microphone (audio), whisper (stt), model
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
| `area_colar` | Reads the clipboard: the file paths, or the text |

Events in the other direction: `pty://data` (output in base64) and `pty://exit`.

## Features

**Terminal**
- Your real login shell (`$SHELL -l`) on a PTY, drawn by xterm.js, with a cat-paw cursor
- Tabs and split panels (side / below), focus moved with `⌘⌥` + arrows, a panel
  maximized and restored with `⌘⇧↩`
- Reopen the closed tab (`⌘⇧T`), and optionally restore the tabs on launch, in the
  same folders, resuming their Claude sessions
- Files dropped from Finder become escaped paths on the line; `⌘⇧V` pastes the path
  of the copied file
- File references in the output (`src/main.ts:848`) open in the built-in viewer
- Quitting asks first
- Interface in Portuguese or English, following the macOS language

**Claude Code** (through the hook)
- Each tab shows its Claude session's state — working, waiting for you —, the Dock
  badge counts the ones waiting, and `⌘⇧A` jumps to the panel that's waiting
- Panel bar with the session's context, model and effort: click to compact
  (`⌘⇧K`), switch model or switch effort
- Context turns yellow, then red with a pulsing border, and auto-compact can kick in
  on its own — thresholds in Preferences (`⌘,`)
- Footer with the usage of the 5-hour and 7-day limits
- Chat mode (`⌘⇧C`): the conversation read from the transcript, with Claude's
  questions and permission requests answered by click, `/` commands, pasted images,
  resuming earlier sessions and each edit's diff
- Jump to your previous / next message in the terminal (`⌘⇧↑` / `⌘⇧↓`)
- Set up from the menu: **TermIAu ▸ Connect to Claude Code…**

**File viewer**
- Opens a file beside, below or over the terminal (`⌘⇧O`), with Markdown rendered or
  as source, previous / next file, and **Open in editor** with a configurable command
- `termiau ver <file>[:line]` opens it from the shell; `--ref` shows the file as it is
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
- Ask Claude about a snippet — default model, Haiku or Opus, optionally with a
  session as context —, let it edit the files and undo what it changed, and turn the
  conversation into a bookmark
- Warns when the repository gets new commits

**Dictation** (`⌘E`)
- Local transcription with Whisper (whisper-rs, Metal): the model (466 MB) is
  downloaded once
- The text is sent after a short countdown that typing cancels, and listening turns
  itself off after a minute of silence

**Play button**
- Runs `.vscode/launch.json` configurations — Dart, Flutter (with hot reload and hot
  restart buttons), Node, Python, Go — in the app's terminal, with the
  `preLaunchTask` from `tasks.json`, stop and restart

**Radio**
- 257 internet stations across 15 genres, with a picker, a spectrum analyser, a
  five-step volume ring and `⌘⇧P` to play or pause
- Closed while playing, it opens playing

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
esperando você —, a barra do painel mostra o contexto da sessão e o rodapé, o
uso dos limites de 5h e de 7 dias. Tudo isso só chega pelo socket do app, e
quem escreve ali é um hook, que precisa estar registrado no `settings.json` do
Claude Code. Pelo app, é **TermIAu ▸ Ligar ao Claude Code…**; pelo repo:

```bash
./hooks/instalar.sh
```

O script copia o `termiau-evento.sh` para `~/.claude/hooks/` (e não aponta para
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
  "command": "bash ~/.claude/hooks/termiau-evento.sh status",
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

## A rádio

No canto direito do rodapé, do outro lado da onda da escuta: ☰ para a lista, ▶,
a seta de próxima estação, o volume e o nome do que está tocando. São **257
rádios em 15 gêneros** — eletrônica underground, freeform, jazz, ambient, campus,
chiptune, world, metal —, tocadas por um `<audio>` da própria página.

A lista vem de
[recommended-radio-streams](https://github.com/deroverda/recommended-radio-streams),
uma curadoria em CC0. O CC0 cobre a **lista**; cada estação tem os termos dela.
As 430 originais passaram por três filtros, e cada um foi **medido**, não
presumido:

1. **Só `https`.** De uma página `tauri://` o WebKit recusa stream `http` como
   conteúdo misto — `NotSupportedError` no `play()`. Corta 113.
2. **Só as que responderam** a uma sondagem tocando de verdade numa WebView: 55
   deram erro, recusa ou silêncio.
3. As 257 que sobraram entram, marcadas pelo que o Web Audio consegue ver.

> Antes daqui a rádio foi a SomaFM, e antes disso lives do YouTube.
>
> O YouTube tocava em `npm run app:dev` e **não tocava no app instalado**: em
> release a janela roda em `tauri://localhost`, e dessa origem o YouTube recusa o
> embed com o erro 153 — o player abre, responde ao `onReady` e fica mudo. O
> esquema não é escolha nossa: no macOS o Tauri sempre serve a janela por
> `tauri://`, e o `useHttpsScheme` só vale para Windows e Android.
>
> A SomaFM saiu por licença, não por técnica. Os termos deles, atualizados em
> 04/09/2026, dizem que **não podem autorizar cliente de terceiro, nem sem fins
> lucrativos**, e que o polling de now-playing é motivo de bloqueio. Tocava
> perfeito; não podia ficar.

### Os dois caminhos de áudio

São **dois** elementos `<audio>`, e não um. Uma fonte de outra origem que não
libera CORS entra no Web Audio zerada — e como o grafo é quem fala com o
alto-falante, ela tocaria em silêncio.

O cabeçalho não basta para saber quem é quem: das 312 sondadas, **249 mandavam
`Access-Control-Allow-Origin` e só 56 entregam amostra de verdade**. Por isso a
marca no `estacoes.ts` saiu de playback real, e não de um `curl`.

- **56 estações** vão pelo `audioGrafo`: `crossOrigin="anonymous"` → analisador →
  ganho → alto-falante. Espectro e anel de volume.
- **201 estações** vão pelo `audioDireto`: fora do grafo, volume pelo `volume` do
  elemento, mostrador parado. No seletor elas levam a marca "sem espectro".

A marca envelhece — servidor muda de configuração. Três segundos depois de
começar, se a estação entrou pelo grafo e o grafo não recebeu nada, ela é
rebaixada e recomeça pelo caminho direto: tocar mudo é pior que tocar sem
mostrador.

Nada de rede antes do ▶ (`preload="none"`): sem apertar o play o rodapé sobe mudo
e o app não fala com ninguém. E tudo o que o ▶ precisa acontece dentro do gesto
do clique, sem `await` no meio — o WebKit só libera áudio sob um gesto seu, e o
gesto não atravessa uma espera. Com um `await ctx.resume()` antes do `play()`, o
play cai do outro lado do clique e é recusado, com um `NotSupportedError` que
ainda por cima não parece o que é.

### O volume e o nome

O volume é um **anel de cinco estágios**: mudo, 25, 50, 75, 100. Um clique sobe um
degrau e, depois do cheio, volta ao mudo; o anel acende no sentido do relógio no
mesmo roxo do ▶, e no mudo apaga e aparece um corte. Era um slider, e um slider
quer um alvo comprido para o ponteiro andar — comprido é o que não sobra numa
faixa de 30px. Assim o rodapé inteiro cabe em 219px.

No grafo o volume mora num `GainNode`, e não no `volume` do `<audio>`: desviado o
elemento para dentro do Web Audio, o WebKit para de aplicar aquele atributo — ele
aceita o valor, o `a.volume` passa a valer o que você pôs e o som sai igual. Com
`volume = 0` a amostra continua cheia. Fora do grafo o atributo volta a valer, e
é ele que o caminho direto usa.

A faixa do nome tem **largura fixa**, de 100px. Com um teto de largura ela
encolhia e crescia a cada estação nova, e os botões e o volume, que vêm antes
dela na mesma linha, pulavam de um lado para o outro. O que não cabe passeia lá
dentro: anda até o fim a ~33 px/s, espera com o rabo do texto à vista, volta ao
começo de uma vez e para trinta segundos antes de andar de novo.

Não há "tocando agora": rádio comunitária não tem API de now-playing, e ler o
`icy-name` de cada uma exigiria uma segunda conexão ao servidor delas só para
isso — o que dobra a banda que se consome de uma rádio pequena.

### O espectro

Dez colunas recortadas em segmentos, como um mostrador de LEDs, com o pico que
fica no ar e desce sozinho. As alturas são **medidas**: FFT de 2048 pontos, dez
bandas espaçadas em oitavas entre 40 Hz e 16 kHz, cada coluna com o maior valor
da sua banda.

A escala de cada banda é **móvel**. Um teto fixo não existe: medido, a banda mais
grave vive a -45 dB e a mais aguda a -77, e essa distância muda com o gênero —
com uma janela fixa as colunas ficam todas no topo. Então cada banda carrega o
próprio teto, que sobe no pico e desce ~1,2 dB/s, e o mostrador cobre os 16 dB
abaixo dele. Dá três segmentos no corpo da música e cinco nos picos. O teto tem
piso (-58 dB) porque sem ele o silêncio entre faixas viraria ganho infinito e o
chiado subiria até em cima.

Os valores vêm em dB crus (`getFloatFrequencyData`): o byte do
`getByteFrequencyData` já chega espremido numa janela fixa de -100 a -30 dB, e é
justamente a janela que não podia ser fixa. As bandas também não podem se
empilhar — a 2048 pontos a resolução é de 23 Hz, e a 512 as três primeiras
caíam todas nas duas primeiras raias, uma delas a componente contínua, que não é
som e não sai do lugar.

O analisador vem **antes** do ganho, para medir pré-fader como qualquer mesa: no
volume baixo as colunas continuam contando o que está tocando em vez de morrerem
junto com o som.

### O seletor

O ☰ do rodapé ou **Rádio ▸ Estações…** abrem a lista, com o gênero ao lado de
cada nome — duzentos e cinquenta nomes não dizem o que tocam. As 56 com espectro
vêm primeiro; as outras levam a marca "sem espectro". Clicar num nome põe a
estação no ar; a que está tocando fica em roxo e entra na vista sozinha quando a
lista abre. `esc`, o ✕ ou um clique no escuro fecham.

Refazer a lista é rodar a sondagem de novo: rádio pequena sai do ar, e o seletor
avisa quando uma não abre.

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
| `⌘E` | Liga e desliga a escuta (falar em vez de digitar) |
| `⌘⇧P` | Toca ou pausa a rádio |

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
hooks/
  termiau-evento.sh   o hook: manda o evento do Claude pro socket do app
  instalar.sh         registra o hook no settings.json do Claude Code
scripts/
  instalar.sh         empacota e põe em /Applications (canal dev ou prod)
src-tauri/
  src/lib.rs          PTY, comandos, menu e o socket dos hooks
  src/main.rs         entrypoint
  src/area.rs         a área de transferência do macOS, para o ⌘⇧V
  src/escuta/         transcrição local: microfone (audio), whisper (stt), modelo
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
| `area_colar` | Lê a área de transferência: os caminhos dos arquivos, ou o texto |

Eventos na direção contrária: `pty://data` (saída em base64) e `pty://exit`.

## Funcionalidades

**Terminal**
- O seu login shell de verdade (`$SHELL -l`) num PTY, desenhado pelo xterm.js, com o
  cursor patinha
- Abas e painéis divididos (ao lado / abaixo), foco movido com `⌘⌥` + setas, painel
  maximizado e recolhido com `⌘⇧↩`
- Reabrir a aba fechada (`⌘⇧T`) e, se quiser, restaurar as abas ao abrir, nas mesmas
  pastas, retomando as sessões do Claude
- Arquivos soltos do Finder viram caminhos escapados na linha; `⌘⇧V` cola o caminho
  do arquivo copiado
- Referências de arquivo na saída (`src/main.ts:848`) abrem no visor embutido
- Sair pergunta antes
- Interface em português ou inglês, seguindo o idioma do macOS

**Claude Code** (pelo hook)
- Cada aba mostra o estado da sessão do Claude — trabalhando, esperando você —, o
  badge do Dock conta as que esperam e `⌘⇧A` leva ao painel que espera
- Barra do painel com o contexto, o modelo e o esforço da sessão: clique para
  compactar (`⌘⇧K`), trocar o modelo ou trocar o esforço
- O contexto fica amarelo, depois vermelho com a borda pulsando, e o auto-compact pode
  ir sozinho — os limites ficam nas Preferências (`⌘,`)
- Rodapé com o uso dos limites de 5 horas e de 7 dias
- Modo chat (`⌘⇧C`): a conversa lida do transcript, com as perguntas e os pedidos de
  permissão do Claude respondidos num clique, comandos `/`, imagens coladas, retomada
  de sessões anteriores e o diff de cada edição
- Ir para a sua mensagem anterior / seguinte no terminal (`⌘⇧↑` / `⌘⇧↓`)
- Instalação pelo menu: **TermIAu ▸ Ligar ao Claude Code…**

**Visor de arquivos**
- Abre um arquivo ao lado, abaixo ou por cima do terminal (`⌘⇧O`), com Markdown
  renderizado ou em fonte, arquivo anterior / próximo e **Abrir no editor** com um
  comando configurável
- `termiau ver <arquivo>[:linha]` abre pelo shell; `--ref` mostra o arquivo como está
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
- Perguntar ao Claude sobre um trecho — modelo padrão, Haiku ou Opus, com uma sessão
  como contexto se quiser —, deixar que ele edite os arquivos e desfazer o que mudou,
  e transformar a conversa num marcador
- Avisa quando o repositório recebe commits novos

**Escuta** (`⌘E`)
- Transcrição local com Whisper (whisper-rs, Metal): o modelo (466 MB) é baixado uma
  vez só
- O texto vai depois de uma contagem curta que digitar cancela, e a escuta se desliga
  depois de um minuto sem falar

**Botão de play**
- Roda as configurações do `.vscode/launch.json` — Dart, Flutter (com botões de hot
  reload e hot restart), Node, Python, Go — no terminal do app, com a `preLaunchTask`
  do `tasks.json`, parar e reiniciar

**Rádio**
- 257 rádios de internet em 15 gêneros, com seletor, analisador de espectro, anel de
  volume de cinco estágios e `⌘⇧P` para tocar ou pausar
- Fechada tocando, abre tocando

</details>
