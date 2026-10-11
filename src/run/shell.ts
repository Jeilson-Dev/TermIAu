// Command-line pieces for the panel's shell (zsh, bash).

/// Path -> command-line piece. Everything outside the safe set
/// gets a backslash in front, which is what Finder does when dragging a
/// file into Terminal.app: `/Users/me/My Documents` becomes
/// `/Users/me/My\ Documents` and stays readable and editable — with quotes
/// around it, it wouldn't. Accents and emoji stay as they are: a high byte isn't
/// special to any shell, and `Edi\ç\ão` would be ugly for nothing.
const INSEGURO = /[^\w@%+=:,./-￿-]/g;

export function citar(caminho: string): string {
  // A newline in the name is the only case the backslash doesn't solve: it
  // would become a line continuation. Then single quotes are worth the ugliness.
  if (/[\n\r]/.test(caminho)) return `'${caminho.replace(/'/g, "'\\''")}'`;
  return caminho.replace(INSEGURO, (c) => `\\${c}`);
}

const ENV = /(\$\{env:[A-Za-z_]\w*\})/;

/// A command word coming from launch.json. The text goes protected, and each
/// `${env:X}` becomes `"${X}"` for the shell itself to expand: it is the one with the
/// environment from your .zshrc, not the app.
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
