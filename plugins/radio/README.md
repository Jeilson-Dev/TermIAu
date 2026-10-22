# Radio — a TermIAu plugin

The footer radio, extracted from the app into a plugin. Build the package with
`npm run plugin:radio` (it writes `dist-plugins/termiau.radio-1.0.0.termiau`) and
install it from **Preferences ▸ Plugins ▸ Install from file…**. The station, the
volume and whether it was playing carry over from when the radio was built in.

The code is `src/main.ts` (`activate` / `deactivate`), the list `src/stations.ts`,
the texts `src/i18n.ts`, the styles `style.css`, and the manifest `termiau.json`.

## English

In the right corner of the footer: ☰ for the list, ▶,
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
tag in `stations.ts` came from real playback, not from a `curl`.

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

## Português

No canto direito do rodapé: ☰ para a lista, ▶,
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
marca no `stations.ts` saiu de playback real, e não de um `curl`.

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
