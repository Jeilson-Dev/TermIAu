// Pedaços de linha de comando para o shell do painel (zsh, bash).

/// Caminho -> pedaço de linha de comando. Tudo que não for do conjunto seguro
/// sai com contrabarra na frente, que é o que o Finder faz ao arrastar um
/// arquivo pro Terminal.app: `/Users/eu/Meus Documentos` vira
/// `/Users/eu/Meus\ Documentos` e continua legível e editável — com aspas em
/// volta, não continuaria. Acento e emoji ficam como estão: byte alto não é
/// especial para nenhum shell, e `Edi\ç\ão` seria feio à toa.
const INSEGURO = /[^\w@%+=:,./-￿-]/g;

export function citar(caminho: string): string {
  // Quebra de linha no nome é o único caso que a contrabarra não resolve: ela
  // viraria continuação de linha. Aí as aspas simples valem a feiura.
  if (/[\n\r]/.test(caminho)) return `'${caminho.replace(/'/g, "'\\''")}'`;
  return caminho.replace(INSEGURO, (c) => `\\${c}`);
}

const ENV = /(\$\{env:[A-Za-z_]\w*\})/;

/// Uma palavra de comando vinda do launch.json. O texto vai protegido, e cada
/// `${env:X}` vira `"${X}"` para o próprio shell expandir: quem tem o ambiente
/// do seu .zshrc é ele, não o app.
export function palavra(valor: string): string {
  if (valor === "") return "''";
  return valor
    .split(ENV)
    .map((parte) => {
      const env = /^\$\{env:(\w+)\}$/.exec(parte);
      return env ? `"\${${env[1]}}"` : parte && citar(parte);
    })
    .join("");
}
