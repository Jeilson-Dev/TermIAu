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
    let key = t.to_lowercase();
    let key = key.trim_matches(|c: char| !c.is_alphanumeric());

    // o Whisper produz estas frases sozinho quando ouve só silêncio
    const LIXO: [&str; 9] = [
        "you", "thank you", "obrigado", "obrigada", "tchau",
        "legendas pela comunidade amara.org", "amara.org",
        "legendas pela comunidade", "subtitles by the amara.org community",
    ];
    if key.is_empty() || LIXO.contains(&key) {
        return String::new();
    }
    t
}

#[cfg(test)]
mod tests {
    use super::clean;

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
    }
}

fn rms(x: &[f32]) -> f32 {
    if x.is_empty() {
        return 0.0;
    }
    (x.iter().map(|v| v * v).sum::<f32>() / x.len() as f32).sqrt()
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
            // só roda o modelo se houve som de verdade no trecho
            if rms(&pending) >= SILENCE_RMS {
                match engine.transcribe(&pending) {
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
            if rms(&pending) >= SILENCE_RMS {
                if let Ok(t) = engine.transcribe(&pending) {
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
    if pending.len() >= MIN_SAMPLES / 2 && rms(&pending) >= SILENCE_RMS {
        if let Ok(t) = engine.transcribe(&pending) {
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
