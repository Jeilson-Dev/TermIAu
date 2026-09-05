//! Motor de transcrição: recebe áudio 16 kHz mono e emite trechos
//! parciais (provisórios) e finais (confirmados).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::Arc;
use std::time::{Duration, Instant};

use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

pub const SAMPLE_RATE: usize = 16_000;

/// Whisper exige pelo menos 1 s de áudio.
const MIN_SAMPLES: usize = SAMPLE_RATE;
/// Reavalia o parcial a cada tanto.
const PARTIAL_EVERY: Duration = Duration::from_millis(800);
/// Silêncio contínuo que fecha um trecho.
const SILENCE_TO_COMMIT: Duration = Duration::from_millis(700);
/// Mesmo falando sem parar, fecha o trecho neste limite.
const MAX_SEGMENT: usize = SAMPLE_RATE * 14;
/// Abaixo disso consideramos silêncio.
const SILENCE_RMS: f32 = 0.006;
/// Quadro de 20 ms: a unidade em que perguntamos "tem voz aqui?".
const QUADRO: usize = SAMPLE_RATE / 50;
/// Fração mínima do trecho com energia de fala para valer rodar o modelo.
/// Era só o RMS do trecho inteiro, e é por isso que a alucinação passava: 14 s
/// de silêncio com uma batida de tecla no meio têm média acima do limiar, e o
/// Whisper preenche o vazio com o que mais viu no treino — legenda de YouTube
/// pedindo like e inscrição.
const MIN_FRACAO_FALA: f32 = 0.08;
/// E um piso absoluto: menos de 250 ms de voz não é palavra nenhuma.
const MIN_MS_FALA: usize = 250;
/// Folga que fica em volta da fala ao cortar as pontas, em quadros.
const FOLGA_QUADROS: usize = 3;

pub enum Event {
    Partial(String),
    Final(String),
    Status(String),
    Error(String),
}

pub struct Engine {
    ctx: WhisperContext,
    lang: String,
    threads: i32,
}

impl Engine {
    pub fn load(model_path: &str, lang: &str) -> anyhow::Result<Self> {
        let ctx = WhisperContext::new_with_params(model_path, WhisperContextParameters::default())
            .map_err(|e| anyhow::anyhow!("não consegui carregar o modelo: {e}"))?;
        let threads = std::thread::available_parallelism()
            .map(|n| (n.get() as i32 - 2).max(2))
            .unwrap_or(4);
        Ok(Self { ctx, lang: lang.to_string(), threads })
    }

    fn params(&self) -> FullParams<'_, '_> {
        let mut p = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        p.set_n_threads(self.threads);
        p.set_translate(false);
        if self.lang != "auto" {
            p.set_language(Some(&self.lang));
        } else {
            p.set_detect_language(true);
        }
        p.set_no_context(true);       // cada janela é independente: evita loops de alucinação
        p.set_single_segment(false);
        p.set_suppress_blank(true);
        p.set_suppress_nst(true);     // suprime tokens não-fala
        p.set_temperature(0.0);
        p.set_no_speech_thold(0.6);
        p.set_print_special(false);
        p.set_print_progress(false);
        p.set_print_realtime(false);
        p.set_print_timestamps(false);
        p
    }

    fn transcribe(&self, audio: &[f32]) -> anyhow::Result<String> {
        // padding até 1 s, senão o whisper.cpp recusa
        let mut buf;
        let audio = if audio.len() < MIN_SAMPLES {
            buf = vec![0.0; MIN_SAMPLES];
            buf[..audio.len()].copy_from_slice(audio);
            &buf[..]
        } else {
            audio
        };

        let mut state = self
            .ctx
            .create_state()
            .map_err(|e| anyhow::anyhow!("estado do whisper: {e}"))?;
        state
            .full(self.params(), audio)
            .map_err(|e| anyhow::anyhow!("falha na inferência: {e}"))?;

        let mut out = String::new();
        for seg in state.as_iter() {
            // descarta segmentos que o próprio modelo considera silêncio
            if seg.no_speech_probability() > 0.75 {
                continue;
            }
            if let Ok(t) = seg.to_str_lossy() {
                out.push_str(t.as_ref());
            }
        }
        Ok(clean(&out))
    }
}

/// Dobra acento e caixa e joga fora pontuação: a alucinação chega enfeitada e
/// diferente a cada vez ("Não se esqueça de se inscrever no canal!"), então a
/// comparação tem que ser sobre uma forma só.
fn normalizar(s: &str) -> String {
    let mut fora = String::with_capacity(s.len());
    let mut espaco = true;
    for c in s.chars() {
        let c = match c.to_lowercase().next().unwrap_or(c) {
            'á' | 'à' | 'ã' | 'â' | 'ä' => 'a',
            'é' | 'ê' | 'è' | 'ë' => 'e',
            'í' | 'ì' | 'î' | 'ï' => 'i',
            'ó' | 'ô' | 'õ' | 'ò' | 'ö' => 'o',
            'ú' | 'ù' | 'û' | 'ü' => 'u',
            'ç' => 'c',
            'ñ' => 'n',
            outro => outro,
        };
        if c.is_alphanumeric() {
            fora.push(c);
            espaco = false;
        } else if !espaco {
            fora.push(' ');
            espaco = true;
        }
    }
    fora.trim().to_string()
}

/// Remove marcadores ([MÚSICA], (risos)) e alucinações típicas de silêncio.
fn clean(s: &str) -> String {
    let mut t = s.trim().to_string();

    // marcadores curtos entre colchetes ou parênteses
    loop {
        let Some(a) = t.find(['[', '(']) else { break };
        let Some(b) = t[a..].find([']', ')']).map(|i| a + i) else { break };
        if b - a > 40 {
            break;
        }
        t.replace_range(a..=b, " ");
    }

    let t = t.split_whitespace().collect::<Vec<_>>().join(" ");
    let key = normalizar(&t);

    // Frase curta e sozinha: o Whisper devolve estas quando ouve só silêncio.
    // Igualdade exata, porque "obrigado" no meio de uma frase é fala de verdade.
    const LIXO: [&str; 9] = [
        "you", "thank you", "obrigado", "obrigada", "tchau",
        "legendas pela comunidade amara org", "amara org",
        "legendas pela comunidade", "subtitles by the amara org community",
    ];
    if key.is_empty() || LIXO.contains(&key.as_str()) {
        return String::new();
    }

    // O treino do Whisper em português é cheio de legenda de YouTube, e o vídeo
    // médio termina pedindo like e inscrição. Estas ele inventa em cima de
    // silêncio e de ruído de ventilador, sempre com uma redação diferente —
    // por isso casamos por conteúdo, não por igualdade. O preço é não dar para
    // ditar estas frases de propósito, e ditar "deixa o like" para um shell não
    // é caso de uso que exista.
    const ISCAS: [&str; 24] = [
        "inscreva se no canal", "se inscreva no canal", "inscrever no canal",
        "se inscrever no canal", "nao se esqueca de se inscrever",
        "esqueca de se inscrever", "se inscreve no canal",
        "deixe o seu like", "deixa o seu like", "deixe seu like",
        "deixa seu like", "deixe um like", "deixa um like", "deixa o like",
        "deixe o like", "ative o sininho", "ativa o sininho",
        "obrigado por assistir", "obrigada por assistir",
        "ate o proximo video", "compartilhe o video", "curta o video",
        "like and subscribe", "dont forget to subscribe",
    ];
    if ISCAS.iter().any(|isca| key.contains(isca)) {
        return String::new();
    }

    t
}

#[cfg(test)]
mod tests {
    use super::{clean, normalizar};

    #[test]
    fn a_isca_do_youtube_nao_passa() {
        // Todas estas o Whisper entregou em cima de silêncio, em algum momento.
        for frase in [
            "Se inscreva no canal e deixe o seu like!",
            "Não se esqueça de se inscrever no canal.",
            "Inscreva-se no canal, ative o sininho.",
            "Obrigado por assistir, até o próximo vídeo!",
            "deixa o like aí galera",
        ] {
            assert_eq!(clean(frase), "", "passou: {frase}");
        }
    }

    #[test]
    fn normalizar_dobra_acento_e_pontuacao() {
        assert_eq!(normalizar("Inscreva-se, JÁ!"), "inscreva se ja");
        assert_eq!(normalizar("  ação   ç  "), "acao c");
    }

    #[test]
    fn tira_marcadores_e_alucinacoes() {
        assert_eq!(clean("  [MÚSICA]  bom dia  "), "bom dia");
        assert_eq!(clean("(risos) tudo certo"), "tudo certo");
        assert_eq!(clean("Obrigado."), "");
        assert_eq!(clean("Legendas pela comunidade Amara.org"), "");
        assert_eq!(clean("[MÚSICA]"), "");
        assert_eq!(clean("a   reunião    começa   já"), "a reunião começa já");
    }

    #[test]
    fn preserva_fala_de_verdade() {
        let s = "obrigado pela ajuda, vou revisar hoje";
        assert_eq!(clean(s), s);
        // "like" e "canal" fora do bordão continuam passando.
        let s = "gostei do canal de áudio novo";
        assert_eq!(clean(s), s);
    }
}

#[cfg(test)]
mod portao {
    use super::*;

    /// Trecho de `ms` milissegundos, com fala nos milissegundos de `fala`.
    fn trecho(ms: usize, fala: std::ops::Range<usize>) -> Vec<f32> {
        (0..SAMPLE_RATE * ms / 1000)
            .map(|i| {
                let t = i * 1000 / SAMPLE_RATE;
                // Onda bem acima do limiar onde há fala; zero no resto.
                if fala.contains(&t) { if i % 2 == 0 { 0.3 } else { -0.3 } } else { 0.0 }
            })
            .collect()
    }

    #[test]
    fn silencio_com_um_estalo_nao_abre_o_portao() {
        // O caso da alucinação: 14 s de nada com 40 ms de barulho no meio.
        let a = trecho(14_000, 7_000..7_040);
        assert!(super::rms(&a) >= SILENCE_RMS, "o portão antigo abriria aqui");
        assert!(!tem_fala(&a), "o portão novo tem que fechar");
    }

    #[test]
    fn meio_segundo_de_fala_abre_o_portao() {
        assert!(tem_fala(&trecho(2_000, 500..1_000)));
    }

    #[test]
    fn silencio_puro_nao_abre_o_portao() {
        assert!(!tem_fala(&trecho(3_000, 0..0)));
        assert!(recortar(&trecho(3_000, 0..0)).is_empty());
    }

    #[test]
    fn recorte_tira_as_pontas_e_guarda_a_fala() {
        let a = trecho(5_000, 2_000..2_500);
        let corte = recortar(&a);
        // Sobra a fala mais a folga das duas pontas, não os 5 s.
        let esperado = SAMPLE_RATE * 500 / 1000 + 2 * FOLGA_QUADROS * QUADRO;
        assert!(corte.len() <= esperado, "cortou de menos: {}", corte.len());
        assert!(corte.len() >= SAMPLE_RATE * 500 / 1000, "cortou fala: {}", corte.len());
        // E o que sobrou ainda é fala aos olhos do portão.
        assert!(tem_fala(corte));
    }
}

fn rms(x: &[f32]) -> f32 {
    if x.is_empty() {
        return 0.0;
    }
    (x.iter().map(|v| v * v).sum::<f32>() / x.len() as f32).sqrt()
}

/// Vale rodar o modelo neste trecho? Conta quadros com voz em vez de olhar o
/// RMS da média: um estalo de 40 ms perdido em silêncio levanta a média o
/// bastante para o portão antigo abrir, e o que sai de lá é alucinação.
fn tem_fala(audio: &[f32]) -> bool {
    let total = audio.len() / QUADRO;
    if total == 0 {
        return false;
    }
    let com_voz = audio.chunks_exact(QUADRO).filter(|q| rms(q) >= SILENCE_RMS).count();
    com_voz * 20 >= MIN_MS_FALA && com_voz as f32 / total as f32 >= MIN_FRACAO_FALA
}

/// Corta o silêncio das pontas, deixando uma folga. O rabo de silêncio é o
/// convite para a alucinação: o modelo segue "transcrevendo" o que não tem, e
/// preenche com legenda de vídeo. O silêncio do meio fica — é pausa entre
/// palavras, e tirá-lo colaria frases que não foram ditas juntas.
fn recortar(audio: &[f32]) -> &[f32] {
    let voz: Vec<bool> = audio.chunks_exact(QUADRO).map(|q| rms(q) >= SILENCE_RMS).collect();
    let Some(a) = voz.iter().position(|&v| v) else { return &[] };
    let b = voz.iter().rposition(|&v| v).unwrap_or(a);
    let ini = a.saturating_sub(FOLGA_QUADROS) * QUADRO;
    let fim = ((b + 1 + FOLGA_QUADROS) * QUADRO).min(audio.len());
    &audio[ini..fim]
}

/// Laço principal: consome áudio até o sinal de parada.
pub fn run(
    engine: Engine,
    audio_rx: Receiver<Vec<f32>>,
    stop: Arc<AtomicBool>,
    emit: impl Fn(Event),
) {
    let mut pending: Vec<f32> = Vec::with_capacity(MAX_SEGMENT);
    let mut last_partial = Instant::now();
    let mut silence_since: Option<Instant> = None;
    let mut last_partial_text = String::new();

    emit(Event::Status("escutando".into()));

    while !stop.load(Ordering::Relaxed) {
        // drena tudo que chegou
        match audio_rx.recv_timeout(Duration::from_millis(120)) {
            Ok(chunk) => {
                let level = rms(&chunk);
                silence_since = if level < SILENCE_RMS {
                    Some(silence_since.unwrap_or_else(Instant::now))
                } else {
                    None
                };
                pending.extend_from_slice(&chunk);
                while let Ok(more) = audio_rx.try_recv() {
                    if rms(&more) >= SILENCE_RMS {
                        silence_since = None;
                    }
                    pending.extend_from_slice(&more);
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }

        if pending.len() < MIN_SAMPLES / 2 {
            continue;
        }

        let quiet_for = silence_since.map(|t| t.elapsed()).unwrap_or_default();
        let commit = (quiet_for >= SILENCE_TO_COMMIT && pending.len() >= MIN_SAMPLES / 2)
            || pending.len() >= MAX_SEGMENT;

        if commit {
            // só roda o modelo se houve fala de verdade no trecho
            if tem_fala(&pending) {
                match engine.transcribe(recortar(&pending)) {
                    Ok(t) if !t.is_empty() => emit(Event::Final(t)),
                    Ok(_) => emit(Event::Partial(String::new())),
                    Err(e) => emit(Event::Error(e.to_string())),
                }
            } else {
                emit(Event::Partial(String::new()));
            }
            pending.clear();
            last_partial_text.clear();
            silence_since = None;
            last_partial = Instant::now();
        } else if last_partial.elapsed() >= PARTIAL_EVERY && pending.len() >= MIN_SAMPLES {
            if tem_fala(&pending) {
                if let Ok(t) = engine.transcribe(recortar(&pending)) {
                    if t != last_partial_text {
                        last_partial_text = t.clone();
                        emit(Event::Partial(t));
                    }
                }
            }
            last_partial = Instant::now();
        }
    }

    // fecha o que sobrou no buffer
    if pending.len() >= MIN_SAMPLES / 2 && tem_fala(&pending) {
        if let Ok(t) = engine.transcribe(recortar(&pending)) {
            if !t.is_empty() {
                emit(Event::Final(t));
            }
        }
    }
    emit(Event::Partial(String::new()));
    emit(Event::Status("parado".into()));
}

#[cfg(test)]
mod integracao {
    use super::*;

    /// Transcreve um áudio conhecido com um modelo real.
    /// Pulado se o modelo `tiny` ainda não foi baixado.
    #[test]
    fn transcreve_audio_real() {
        let modelo = dirs_modelo_tiny();
        let wav = std::path::Path::new("/tmp/jfk.wav");
        if !modelo.exists() || !wav.exists() {
            eprintln!("pulando: modelo ou áudio de teste ausente");
            return;
        }

        let audio = ler_wav_16k_mono(wav);
        assert!(audio.len() > SAMPLE_RATE, "áudio curto demais");

        let eng = Engine::load(modelo.to_str().unwrap(), "en").expect("carregar modelo");
        let texto = eng.transcribe(&audio).expect("transcrever").to_lowercase();

        eprintln!("transcrito: {texto}");
        assert!(texto.contains("ask not what your country"), "saiu: {texto}");
    }

    fn dirs_modelo_tiny() -> std::path::PathBuf {
        std::path::PathBuf::from(std::env::var("HOME").unwrap())
            .join("Library/Application Support/ai.dimenso.escuta/models/ggml-tiny.bin")
    }

    /// Leitor mínimo de WAV PCM 16-bit mono a 16 kHz.
    fn ler_wav_16k_mono(p: &std::path::Path) -> Vec<f32> {
        let b = std::fs::read(p).expect("ler wav");
        assert_eq!(&b[0..4], b"RIFF");
        assert_eq!(&b[8..12], b"WAVE");

        let mut i = 12;
        while i + 8 <= b.len() {
            let id = &b[i..i + 4];
            let sz = u32::from_le_bytes(b[i + 4..i + 8].try_into().unwrap()) as usize;
            let body = &b[i + 8..(i + 8 + sz).min(b.len())];
            if id == b"fmt " {
                let ch = u16::from_le_bytes(body[2..4].try_into().unwrap());
                let sr = u32::from_le_bytes(body[4..8].try_into().unwrap());
                let bits = u16::from_le_bytes(body[14..16].try_into().unwrap());
                assert_eq!((ch, sr, bits), (1, 16_000, 16), "esperava mono 16k 16-bit");
            } else if id == b"data" {
                return body
                    .chunks_exact(2)
                    .map(|s| i16::from_le_bytes([s[0], s[1]]) as f32 / 32768.0)
                    .collect();
            }
            i += 8 + sz + (sz & 1);
        }
        panic!("chunk 'data' não encontrado");
    }
}
