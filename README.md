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
