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

## Ligando os avisos do Claude

As abas mostram em que pé está cada sessão do Claude Code — trabalhando,
esperando você —, e isso só chega pelo socket do app. Quem escreve ali é um
hook, que precisa estar registrado no `settings.json` do Claude Code:

```bash
./hooks/instalar.sh
```

O script copia o `termiau-evento.sh` para `~/.claude/hooks/` (e não aponta para
o repo: ele pode estar num volume que não está montado quando o Claude roda),
registra os quatro eventos que o app trata — `UserPromptSubmit`,
`PermissionRequest`, `Notification`, `SessionEnd` — e guarda um backup do
settings anterior. Rodar de novo é inofensivo.

Sem o hook instalado o app sobe normal, só calado: as abas não mostram estado
do Claude e o badge do Dock fica vazio.

## Atalhos

| Atalho | Ação |
| --- | --- |
| `⌘T` | Nova aba |
| `⌘D` / `⌘⇧D` | Divide o painel ao lado / abaixo |
| `⌘W` | Fecha o painel em foco (o último fecha a aba) |
| `⌘1`…`⌘9` | Vai para a aba *n* — `⌘9` vai para a última |
| `⌘⇧[` / `⌘⇧]` | Aba anterior / próxima |
| `⌘⌥←↑→↓` | Move o foco para o painel vizinho |
| `⌘⇧A` | Vai para o painel onde o Claude espera resposta |
| `⌘K` | Limpa a tela |
| `⌘⇧V` | Cola o **caminho** do arquivo que está na área de transferência |
| `⌘E` | Liga e desliga a escuta (falar em vez de digitar) |

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
