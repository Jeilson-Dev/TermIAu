//! O palco: uma fala por vez nesta máquina, venha ela de onde vier.
//!
//! A fila do app da bandeja resolve a ordem *dentro* dele, e é o caminho
//! normal. Mas nem toda fala passa por ali: quando o app está fechado — ou
//! caiu —, cada `fala_claudio` carrega o seu próprio modelo e toca por conta
//! própria. Três hooks disparando ao mesmo tempo viram três vozes por cima
//! umas das outras, que é exatamente o que uma fila existe para impedir.
//!
//! O palco é um cadeado de arquivo (`flock`) num caminho fixo: quem vai falar
//! sobe nele e só desce quando o áudio acabou. Como o cadeado é do sistema
//! operacional, ele vale entre processos, e o núcleo se solta sozinho se o
//! processo morrer — um `fala_claudio` derrubado no meio da frase não deixa a
//! máquina muda.

use crate::caminhos;
use anyhow::Result;
use std::fs::{File, OpenOptions};
use std::os::fd::AsRawFd;
use std::path::PathBuf;
use std::time::Duration;

/// Quanto se espera entre duas tentativas de subir ao palco.
const ESPIADA: Duration = Duration::from_millis(50);

/// O direito de falar. Enquanto ele existir, ninguém mais fala; ao ser
/// descartado, o próximo da vez entra.
/// O arquivo é o cadeado: guardá-lo é o que mantém o `flock` de pé, e
/// fechá-lo (ao largar o `Palco`) é o que passa a vez adiante.
pub struct Palco(#[allow(dead_code)] Option<File>);

impl Palco {
    /// Espera a vez e sobe. Bloqueia até a fala anterior terminar.
    ///
    /// Um palco que não trancou — o arquivo não abriu, o `flock` não existe
    /// nesse sistema de arquivos — ainda deixa falar: uma fala sobreposta é
    /// ruim, silêncio é pior.
    pub fn subir() -> Palco {
        let Ok(arquivo) = abrir() else { return Palco(None) };
        if travar(&arquivo, true) {
            Palco(Some(arquivo))
        } else {
            Palco(None)
        }
    }

    /// Sobe se o palco estiver livre agora; devolve `None` se alguém está
    /// falando. Para quem precisa continuar respondendo enquanto espera.
    pub fn tentar() -> Option<Palco> {
        let arquivo = abrir().ok()?;
        travar(&arquivo, false).then(|| Palco(Some(arquivo)))
    }

    /// Espera a vez sem parar de olhar para trás: `desistir` é consultado a
    /// cada espiada, e um `sim` abandona a espera devolvendo `None`.
    pub fn esperar_a_vez(desistir: impl Fn() -> bool) -> Option<Palco> {
        loop {
            if desistir() {
                return None;
            }
            if let Some(palco) = Palco::tentar() {
                return Some(palco);
            }
            // Sem o arquivo não há como esperar a vez de ninguém; falar já.
            if abrir().is_err() {
                return Some(Palco(None));
            }
            std::thread::sleep(ESPIADA);
        }
    }
}

fn caminho() -> Result<PathBuf> {
    Ok(caminhos::dados()?.join("fala.trava"))
}

fn abrir() -> Result<File> {
    let caminho = caminho()?;
    Ok(OpenOptions::new().create(true).append(true).open(caminho)?)
}

/// `flock` exclusivo. Sem `bloqueando`, devolve `false` na hora se o palco
/// estiver ocupado.
fn travar(arquivo: &File, bloqueando: bool) -> bool {
    let modo = libc::LOCK_EX | if bloqueando { 0 } else { libc::LOCK_NB };
    // `flock` é liberado quando o descritor fecha, inclusive se o processo
    // morrer — por isso o `Palco` não precisa destrancar nada ao ser largado.
    unsafe { libc::flock(arquivo.as_raw_fd(), modo) == 0 }
}

#[cfg(test)]
mod testes {
    use super::*;

    #[test]
    fn dois_nao_sobem_juntos() {
        let primeiro = Palco::subir();
        assert!(Palco::tentar().is_none(), "o palco deixou dois subirem");
        drop(primeiro);
        assert!(Palco::tentar().is_some(), "o palco não liberou ao descer");
    }
}
