# TermIAu

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

## Ligando a voz

O TermIAu fala o que o Claude Code responde, mas só fala o que chega pelo
socket dele — e quem escreve ali é um hook, que precisa estar registrado no
`settings.json` do Claude Code:

```bash
./hooks/instalar.sh
```

O script copia o `termiau-evento.sh` para `~/.claude/hooks/` (e não aponta para
o repo: ele pode estar num volume que não está montado quando o Claude roda),
registra os cinco eventos que o app trata — `UserPromptSubmit`,
`PermissionRequest`, `Notification`, `MessageDisplay`, `SessionEnd` — e guarda
um backup do settings anterior. Rodar de novo é inofensivo.

**Um sistema de voz por máquina.** O instalador também remove do settings
qualquer hook que aponte para `~/.claude/hooks/fala/` — o sistema antigo, em
que cada evento virava um `fala_claudio` próprio. Aqueles processos não passam
pela fila do app, e três hooks assíncronos disparando juntos viram três vozes
por cima umas das outras. Quem garante a vez aqui é a thread única da fila
(`abrir_voz` no `lib.rs`) mais o `Palco`, um `flock` num arquivo fixo que vale
entre processos.

Sem o hook instalado o app sobe normal, com a fila vazia: as abas não mostram
estado do Claude e nada é falado.

## Atalhos

| Atalho | Ação |
| --- | --- |
| `⌘K` | Limpa a tela |

Todo o resto vai direto para o shell.

## Estrutura

```
index.html            casca da janela
src/
  main.ts             xterm, addons e a ponte com os comandos do Tauri
  style.css           tema da janela e o cursor patinha
hooks/
  termiau-evento.sh   o hook: manda o evento do Claude pro socket do app
  instalar.sh         registra o hook no settings.json do Claude Code
src-tauri/
  src/lib.rs          PTY, comandos (pty_spawn/write/resize, js_log) e as threads
  src/main.rs         entrypoint
  tauri.conf.json     janela, bundle e build
  capabilities/       permissões da janela principal
```

## Comandos do Tauri

| Comando | Para quê |
| --- | --- |
| `pty_spawn { rows, cols }` | Abre o PTY e sobe o login shell (matando o anterior) |
| `pty_write { data }` | Manda o que foi digitado para o shell |
| `pty_resize { rows, cols }` | Reajusta a grade e dispara `SIGWINCH` |
| `js_log { msg }` | Joga erros da webview no stderr do processo |

Eventos na direção contrária: `pty://data` (saída em base64) e `pty://exit`.
