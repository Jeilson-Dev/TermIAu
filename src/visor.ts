/// O que o visor precisa saber sem tocar no DOM: achar as referências a arquivo
/// (`src/main.ts:848`) num texto. Fica num módulo à parte para ter teste, como
/// o `conversa.ts`.

/// Uma referência achada num texto. `inicio` e `fim` são posições no texto
/// (`fim` exclusivo), e `arquivo` ainda é como estava escrito: relativo ou não,
/// quem sabe se ele existe é o Rust (`arquivos_existem`).
export type Referencia = {
  inicio: number;
  fim: number;
  arquivo: string;
  linha?: number;
  ate?: number;
};

// Um caminho com extensão (`a/b/c.ts`, `./x.md`, `~/notas.md`), e depois dele,
// opcional, `:linha`, `:linha-linha` ou `:linha:coluna`. Sem espaço no caminho:
// na saída do terminal não há como saber onde um caminho com espaço começa.
// O lookbehind impede começar no meio de outra coisa — de uma URL, sobretudo.
const PADRAO =
  /(?<![\w/.~@+:-])((?:~\/|\.{1,2}\/|\/)?(?:[\w@.+-]+\/)*[\w@+-][\w@.+-]*\.[A-Za-z0-9]{1,10})(?::(\d+)(?:([-–:])(\d+))?)?(?![\w/])/g;

export function acharReferencias(texto: string): Referencia[] {
  const achadas: Referencia[] = [];
  for (const m of texto.matchAll(PADRAO)) {
    const [inteiro, arquivo, linha, sep, segundo] = m;
    // Um número solto (`1.5`, `v2.0`) casa com o padrão, mas não é arquivo.
    if (/^[\d.]+$/.test(arquivo)) continue;
    const ref: Referencia = { inicio: m.index, fim: m.index + inteiro.length, arquivo };
    if (linha) ref.linha = Number(linha);
    // `:10:5` é coluna, e o visor não usa coluna; `:10-20` é um trecho.
    if (segundo && sep !== ":" && Number(segundo) >= Number(linha)) ref.ate = Number(segundo);
    achadas.push(ref);
  }
  return achadas;
}

/// O texto inteiro é uma referência? É o teste do `<code>` do chat: só um
/// código que é só um caminho vira link, e não um trecho que cita um.
export function referenciaInteira(texto: string): Referencia | undefined {
  const t = texto.trim();
  const [ref] = acharReferencias(t);
  return ref && ref.inicio === 0 && ref.fim === t.length ? ref : undefined;
}

/// Uma linha da tela do terminal: o texto dela (com os espaços até a borda) e
/// se o xterm a marcou como continuação da de cima (`isWrapped`).
export type LinhaDaTela = { texto: string; quebrada: boolean };

/// Um texto montado de várias linhas da tela, com a posição de cada caractere
/// nela — é o que leva uma referência achada no texto de volta para a tela.
export type LinhaLogica = { texto: string; pos: { linha: number; col: number }[] };

// Sem `.` e `:` na ponta: é onde as frases acabam, e um caminho partido bem ali
// é raro.
const PONTA = /[\w/~@+-]$/;
const COMECO = /^\s*[\w/.~@+-]/;

/// A linha `i` continua na de baixo? Quando o xterm quebrou a linha, sempre.
/// Com `juntar`, também quando quem quebrou foi o programa: o Claude Code quebra
/// as linhas dele na largura da tela e indenta a continuação, e um caminho
/// longo sai partido em dois. O palpite é estreito — a linha chegou perto da
/// borda e termina, sem espaço, num caractere de caminho, e a de baixo começa
/// com outro —, e quem confirma é o arquivo existir.
export function continua(linhas: LinhaDaTela[], i: number, cols: number, juntar: boolean): boolean {
  const prox = linhas[i + 1];
  if (!prox) return false;
  if (prox.quebrada) return true;
  if (!juntar) return false;
  const atual = linhas[i].texto.trimEnd();
  return atual.length >= cols - 12 && PONTA.test(atual) && COMECO.test(prox.texto);
}

/// A linha lógica que passa pela linha `i` da tela. Uma continuação do
/// programa entra sem a indentação dela; a do xterm, inteira. O palpite vale
/// para cima e para baixo em separado: quem chama tenta as combinações, porque
/// juntar a linha de baixo por engano estragaria o `:103` no fim desta.
export function linhaLogica(
  linhas: LinhaDaTela[],
  i: number,
  cols: number,
  acima: boolean,
  abaixo = acima,
): LinhaLogica {
  let ini = i;
  while (ini > 0 && continua(linhas, ini - 1, cols, acima)) ini--;
  let fim = i;
  while (continua(linhas, fim, cols, abaixo)) fim++;
  let texto = "";
  const pos: LinhaLogica["pos"] = [];
  for (let r = ini; r <= fim; r++) {
    const bruto = linhas[r].texto;
    const de = r > ini && !linhas[r].quebrada ? bruto.length - bruto.trimStart().length : 0;
    const ate = r < fim && linhas[r + 1].quebrada ? bruto.length : bruto.trimEnd().length;
    for (let c = de; c < ate; c++) {
      texto += bruto[c];
      pos.push({ linha: r, col: c });
    }
  }
  return { texto, pos };
}

/// O arquivo é markdown: abre renderizado.
export const ehMarkdown = (caminho: string) => /\.(md|markdown|mdx)$/i.test(caminho);
