//! Empacotar as amostras em WAV e tocar.
//!
//! Dois tocadores, e a diferença entre eles é só quem manda no volume:
//!
//! - [`tocar`] chama o `afplay`. O ganho vai na linha de comando e não muda
//!   mais; cortar a fala é matar o processo. É o caminho do CLI.
//! - [`tocar_aqui`] abre a placa de som neste processo e pergunta o ganho a
//!   cada bloco. É o que deixa a voz abaixar NO MEIO da frase quando você
//!   começa a falar por cima dela — com o `afplay` isso é impossível, porque
//!   quando a frase começou o volume dela já estava decidido.

use anyhow::{bail, Context, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::SampleFormat;
use std::io::Write;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use crate::resample::Resampler;

/// Em quanto tempo o volume anda de um valor ao outro. Um degrau seco no meio
/// da frase estala no alto-falante; 80 ms a orelha lê como "abaixou".
const RAMPA_S: f32 = 0.080;

/// O volume, perguntado a cada bloco de áudio em vez de fixado no começo.
/// Devolve 0..1. É a peça que torna o abafamento ao vivo possível: quem chama
/// entrega uma pergunta, não uma resposta.
pub type Ganho = Arc<dyn Fn() -> f32 + Send + Sync>;

/// Uma fala tocando na placa de som deste processo.
///
/// O `cpal::Stream` não é `Send` no macOS: nasce e morre na thread que o abriu,
/// e é por isso que quem toca é também quem espera. Para cortar a fala de
/// outra thread existe o `parar` que você passou para [`tocar_aqui`] — é um
/// átomo, e atravessa threads sem o stream junto.
pub struct Reproducao {
    _stream: cpal::Stream,
    fim: Arc<(Mutex<bool>, Condvar)>,
    /// Quanto a frase dura. Serve de teto para a espera.
    duracao: Duration,
}

impl Reproducao {
    /// Bloqueia até a fala acabar ou ser cortada.
    ///
    /// Com teto: se a placa de som engasgar, o callback para de rodar e o aviso
    /// de fim nunca chega. Sem o teto, a thread da voz ficaria presa aqui e a
    /// fila inteira emudeceria para sempre — um bug de áudio viraria um app sem
    /// voz. A folga de um segundo cobre a latência de abrir o dispositivo.
    pub fn esperar(&self) {
        let teto = self.duracao + Duration::from_secs(1);
        let (trava, sino) = &*self.fim;
        let acabou = trava.lock().unwrap_or_else(|e| e.into_inner());
        let (acabou, prazo) = sino
            .wait_timeout_while(acabou, teto, |pronto| !*pronto)
            .unwrap_or_else(|e| e.into_inner());
        if prazo.timed_out() && !*acabou {
            eprintln!("[audio] a saída não avisou o fim da fala; seguindo em frente");
        }
    }
}

/// O que sobrevive de um bloco de áudio para o seguinte: onde paramos na fonte
/// e em que volume estamos. Vive fora do callback para poder ser testado sem
/// placa de som nenhuma — é a única parte disto com lógica de verdade.
struct Corrente {
    fonte: Arc<Vec<f32>>,
    canais: usize,
    /// Quanto o ganho anda por amostra, para vencer a `RAMPA_S`.
    passo: f32,
    /// Próxima amostra da fonte.
    i: usize,
    /// Onde o ganho está agora, a caminho do alvo.
    ganho: f32,
}

impl Corrente {
    fn nova(fonte: Arc<Vec<f32>>, canais: usize, taxa_saida: u32, ganho: f32) -> Self {
        Self { fonte, canais: canais.max(1), passo: 1.0 / (RAMPA_S * taxa_saida as f32), i: 0, ganho }
    }

    /// Enche um bloco de saída: a mesma amostra mono em todos os canais, com o
    /// ganho caminhando para `alvo`. Devolve true quando a fala terminou — o
    /// fim da fonte, ou o corte. Nada aqui aloca nem tranca: é callback de
    /// áudio, e uma alocação no meio vira estalo.
    fn bloco(&mut self, saida: &mut [f32], alvo: f32, cortado: bool) -> bool {
        for quadro in saida.chunks_mut(self.canais) {
            self.ganho += (alvo - self.ganho).clamp(-self.passo, self.passo);
            let v = if cortado {
                0.0
            } else {
                self.fonte.get(self.i).copied().unwrap_or(0.0) * self.ganho
            };
            for canal in quadro.iter_mut() {
                *canal = v;
            }
            self.i += 1;
        }
        cortado || self.i >= self.fonte.len()
    }
}

/// Toca amostras mono aqui dentro, perguntando o volume a cada bloco.
///
/// `parar` corta a fala no meio; pode ser levantado de qualquer thread.
pub fn tocar_aqui(
    amostras: &[f32],
    taxa: u32,
    ganho: Ganho,
    parar: Arc<AtomicBool>,
) -> Result<Reproducao> {
    let dispositivo = cpal::default_host()
        .default_output_device()
        .context("nenhuma saída de áudio disponível")?;
    let suportado = dispositivo
        .default_output_config()
        .context("configuração da saída de áudio")?;

    let taxa_saida = suportado.sample_rate();
    let canais = suportado.channels() as usize;
    let formato = suportado.sample_format();
    let config: cpal::StreamConfig = suportado.into();

    // A placa quase nunca roda nos 24 kHz do Kokoro. Reamostrar antes de abrir
    // o stream, e não dentro do callback: lá dentro não se aloca.
    let fonte: Arc<Vec<f32>> = Arc::new(if taxa == taxa_saida {
        amostras.to_vec()
    } else {
        Resampler::new(taxa, taxa_saida).process(amostras)
    });

    let duracao = Duration::from_secs_f64(fonte.len() as f64 / taxa_saida.max(1) as f64);
    let fim = Arc::new((Mutex::new(false), Condvar::new()));
    let mut corrente = Corrente::nova(fonte, canais, taxa_saida, ganho());
    let fim_cb = fim.clone();

    let mut encher = move |saida: &mut [f32]| {
        if corrente.bloco(saida, ganho(), parar.load(Ordering::Relaxed)) {
            let (trava, sino) = &*fim_cb;
            if let Ok(mut pronto) = trava.lock() {
                *pronto = true;
                sino.notify_all();
            }
        }
    };

    let erro = |e| eprintln!("[audio] erro na saída: {e}");

    // A placa pede o formato dela; o nosso é sempre f32 e convertemos na saída.
    let stream = match formato {
        SampleFormat::F32 => dispositivo.build_output_stream(
            config,
            move |d: &mut [f32], _: &_| encher(d),
            erro,
            None,
        ),
        SampleFormat::I16 => dispositivo.build_output_stream(
            config,
            move |d: &mut [i16], _: &_| {
                let mut f = vec![0.0f32; d.len()];
                encher(&mut f);
                for (s, v) in d.iter_mut().zip(f) {
                    *s = (v.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
                }
            },
            erro,
            None,
        ),
        SampleFormat::U16 => dispositivo.build_output_stream(
            config,
            move |d: &mut [u16], _: &_| {
                let mut f = vec![0.0f32; d.len()];
                encher(&mut f);
                for (s, v) in d.iter_mut().zip(f) {
                    *s = ((v.clamp(-1.0, 1.0) * 32767.0) + 32768.0) as u16;
                }
            },
            erro,
            None,
        ),
        outro => bail!("formato de áudio não suportado na saída: {outro:?}"),
    }
    .context("não consegui abrir a saída de áudio")?;

    stream.play().context("não consegui começar a tocar")?;
    Ok(Reproducao { _stream: stream, fim, duracao })
}

/// WAV mono, 16 bits, na taxa dada. Formato que qualquer coisa toca.
pub fn wav(amostras: &[f32], taxa: u32) -> Vec<u8> {
    let bytes_dados = amostras.len() * 2;
    let mut saida = Vec::with_capacity(44 + bytes_dados);

    saida.extend_from_slice(b"RIFF");
    saida.extend_from_slice(&((36 + bytes_dados) as u32).to_le_bytes());
    saida.extend_from_slice(b"WAVEfmt ");
    saida.extend_from_slice(&16u32.to_le_bytes()); // tamanho do bloco fmt
    saida.extend_from_slice(&1u16.to_le_bytes()); // PCM
    saida.extend_from_slice(&1u16.to_le_bytes()); // mono
    saida.extend_from_slice(&taxa.to_le_bytes());
    saida.extend_from_slice(&(taxa * 2).to_le_bytes()); // bytes por segundo
    saida.extend_from_slice(&2u16.to_le_bytes()); // alinhamento
    saida.extend_from_slice(&16u16.to_le_bytes()); // bits por amostra
    saida.extend_from_slice(b"data");
    saida.extend_from_slice(&(bytes_dados as u32).to_le_bytes());

    for amostra in amostras {
        let v = (amostra.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
        saida.extend_from_slice(&v.to_le_bytes());
    }
    saida
}

/// Toca um WAV que já está no disco. Devolve o processo, para quem quiser
/// interromper a fala no meio.
pub fn tocar(arquivo: &Path, volume: u8) -> Result<Child> {
    let ganho = (volume.min(100) as f32 / 100.0).to_string();
    Command::new("afplay")
        .arg("-v")
        .arg(ganho)
        .arg(arquivo)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .context("não consegui chamar o afplay")
}

/// A reserva: a voz sintética do macOS. Pior, instantânea e sempre presente.
/// Ela existe para que uma falha do Kokoro não vire silêncio.
pub fn falar_pelo_macos(texto: &str, voz: &str, volume: u8) -> Result<()> {
    let ganho = (volume.min(100) as f32 / 100.0).clamp(0.0, 1.0);
    let mut filho = Command::new("say")
        .arg("-v")
        .arg(voz)
        .arg("--")
        .arg(format!("[[volm {ganho:.2}]] {texto}"))
        .stdin(Stdio::null())
        .spawn()
        .context("não consegui chamar o `say` do macOS")?;
    let status = filho.wait()?;
    if !status.success() {
        bail!("o `say` terminou com erro ({status})");
    }
    Ok(())
}

/// Lê de volta um WAV escrito por [`wav`]: mono, 16 bits. Devolve as amostras
/// e a taxa. Serve o acerto do cache, onde o áudio já existe em disco e o que
/// se quer são as amostras para tocar aqui dentro.
pub fn ler_wav(caminho: &Path) -> Result<(Vec<f32>, u32)> {
    let b = std::fs::read(caminho).with_context(|| format!("lendo {}", caminho.display()))?;
    if b.len() < 44 || &b[0..4] != b"RIFF" || &b[8..12] != b"WAVE" {
        bail!("{} não é um WAV", caminho.display());
    }

    let mut i = 12;
    let mut taxa = 0u32;
    while i + 8 <= b.len() {
        let id = &b[i..i + 4];
        let tamanho = u32::from_le_bytes(b[i + 4..i + 8].try_into().unwrap()) as usize;
        let corpo = &b[i + 8..(i + 8 + tamanho).min(b.len())];
        if id == b"fmt " && corpo.len() >= 16 {
            taxa = u32::from_le_bytes(corpo[4..8].try_into().unwrap());
        } else if id == b"data" {
            if taxa == 0 {
                bail!("WAV sem cabeçalho de formato antes dos dados");
            }
            let amostras = corpo
                .chunks_exact(2)
                .map(|s| i16::from_le_bytes([s[0], s[1]]) as f32 / 32768.0)
                .collect();
            return Ok((amostras, taxa));
        }
        // Blocos têm tamanho par: um ímpar leva um byte de enchimento.
        i += 8 + tamanho + (tamanho & 1);
    }
    bail!("WAV sem bloco de dados: {}", caminho.display())
}

/// Grava as amostras em disco como WAV.
pub fn gravar(caminho: &Path, amostras: &[f32], taxa: u32) -> Result<()> {
    let mut arquivo = std::fs::File::create(caminho)
        .with_context(|| format!("não consegui escrever em {}", caminho.display()))?;
    arquivo.write_all(&wav(amostras, taxa))?;
    Ok(())
}

/// Onde a fala começa e termina, ignorando o silêncio das pontas.
///
/// O modelo entrega cada lote embrulhado em silêncio — quase dois segundos no
/// começo. Emendar lotes assim soa como buracos no meio da frase, então o
/// silêncio sai daqui e a pausa certa é recolocada depois, do tamanho que a
/// pontuação pedir.
///
/// É o `librosa.effects.trim` com os padrões que o Kokoro usa: quadros de
/// 2048 amostras a cada 512, e silêncio é tudo 60 dB abaixo do pico.
pub fn aparar(amostras: &[f32]) -> (usize, usize) {
    const QUADRO: usize = 2048;
    const SALTO: usize = 512;
    const TETO_DB: f32 = 60.0;
    const MINIMO: f32 = 1e-10;

    let n = amostras.len();
    if n == 0 {
        return (0, 0);
    }

    // O sinal é analisado com meio quadro de silêncio em volta, para que o
    // primeiro quadro fique centrado na primeira amostra.
    let borda = QUADRO / 2;
    let amostra = |i: usize| -> f32 {
        if i < borda || i >= borda + n {
            0.0
        } else {
            amostras[i - borda]
        }
    };

    let quantos = (n + 1).div_ceil(SALTO);
    let potencias: Vec<f32> = (0..quantos)
        .map(|q| {
            let inicio = q * SALTO;
            let soma: f32 = (0..QUADRO).map(|k| amostra(inicio + k).powi(2)).sum();
            soma / QUADRO as f32
        })
        .collect();

    let pico = potencias.iter().copied().fold(0.0f32, f32::max);
    let referencia_db = 10.0 * pico.max(MINIMO).log10();

    let mut primeiro = None;
    let mut ultimo = 0;
    for (q, potencia) in potencias.iter().enumerate() {
        let db = 10.0 * potencia.max(MINIMO).log10() - referencia_db;
        if db > -TETO_DB {
            primeiro.get_or_insert(q);
            ultimo = q;
        }
    }

    match primeiro {
        Some(p) => (p * SALTO, n.min((ultimo + 1) * SALTO)),
        None => (0, 0),
    }
}

/// `segundos` de silêncio em 24 kHz.
pub fn silencio(segundos: f32, taxa: u32) -> Vec<f32> {
    vec![0.0; (segundos * taxa as f32).max(0.0) as usize]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wav_vai_e_volta() {
        let originais: Vec<f32> = (0..2400)
            .map(|i| (i as f32 * 0.05).sin() * 0.8)
            .collect();
        let destino = std::env::temp_dir().join("fala-nucleo-ida-e-volta.wav");
        gravar(&destino, &originais, 24_000).expect("gravar");

        let (lidas, taxa) = ler_wav(&destino).expect("ler");
        assert_eq!(taxa, 24_000);
        assert_eq!(lidas.len(), originais.len());
        // 16 bits: a volta não é exata. O erro cabe em dois passos do formato —
        // um do truncamento na ida e outro da assimetria entre escrever
        // multiplicando por 32767 e ler dividindo por 32768. Dá -90 dB, que é
        // silêncio bem abaixo do ruído de qualquer alto-falante.
        for (a, b) in originais.iter().zip(&lidas) {
            assert!((a - b).abs() < 2.0 / 32_768.0, "{a} virou {b}");
        }
        let _ = std::fs::remove_file(&destino);
    }

    fn corrente(fonte: Vec<f32>, canais: usize, ganho: f32) -> Corrente {
        Corrente::nova(Arc::new(fonte), canais, 48_000, ganho)
    }

    #[test]
    fn o_ganho_nao_pula_de_uma_vez() {
        // Meio volume atrás de volume cheio: a rampa leva RAMPA_S para chegar,
        // e é ela que evita o estalo de um degrau seco no meio da frase.
        let mut c = corrente(vec![1.0; 48_000], 1, 1.0);
        let mut bloco = [0.0f32; 64];
        c.bloco(&mut bloco, 0.5, false);
        assert!(bloco[0] > 0.99, "o primeiro quadro ainda é volume cheio");
        assert!(bloco[63] < bloco[0], "e já está descendo");
        assert!(bloco[63] > 0.5, "sem chegar lá em 64 amostras");

        let amostras_da_rampa = (RAMPA_S * 48_000.0) as usize;
        let mut resto = vec![0.0f32; amostras_da_rampa];
        c.bloco(&mut resto, 0.5, false);
        assert!((resto[amostras_da_rampa - 1] - 0.5).abs() < 0.01, "não chegou a 0,5");
    }

    #[test]
    fn a_mesma_amostra_vai_para_todos_os_canais() {
        let mut c = corrente(vec![1.0, 1.0], 2, 1.0);
        let mut bloco = [0.0f32; 4];
        c.bloco(&mut bloco, 1.0, false);
        assert_eq!(bloco[0], bloco[1], "esquerda e direita iguais");
        assert_eq!(bloco[2], bloco[3]);
    }

    #[test]
    fn a_fonte_acabando_encerra_a_fala() {
        let mut c = corrente(vec![0.5; 100], 1, 1.0);
        let mut bloco = [0.0f32; 64];
        assert!(!c.bloco(&mut bloco, 1.0, false), "ainda tem áudio");
        assert!(c.bloco(&mut bloco, 1.0, false), "acabou a fonte");
        // Depois do fim, silêncio — e não a última amostra repetida.
        assert_eq!(bloco[63], 0.0);
    }

    #[test]
    fn o_corte_cala_na_hora() {
        let mut c = corrente(vec![1.0; 48_000], 1, 1.0);
        let mut bloco = [0.0f32; 64];
        assert!(c.bloco(&mut bloco, 1.0, true), "cortado é fim");
        assert!(bloco.iter().all(|&v| v == 0.0), "e o bloco sai mudo");
    }

    #[test]
    fn arquivo_que_nao_e_wav_nao_passa() {
        let destino = std::env::temp_dir().join("fala-nucleo-nao-wav.bin");
        std::fs::write(&destino, b"isto nao e um RIFF de jeito nenhum").unwrap();
        assert!(ler_wav(&destino).is_err());
        let _ = std::fs::remove_file(&destino);
    }
}
