//! Transcription engine: takes 16 kHz mono audio and emits partial
//! (provisional) and final (confirmed) segments.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::Arc;
use std::time::{Duration, Instant};
use crate::idioma::tr;

use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

pub const SAMPLE_RATE: usize = 16_000;

/// Whisper requires at least 1 s of audio.
const MIN_SAMPLES: usize = SAMPLE_RATE;
/// Re-evaluates the partial every so often.
const PARTIAL_EVERY: Duration = Duration::from_millis(800);
/// Continuous silence that closes a segment.
const SILENCE_TO_COMMIT: Duration = Duration::from_millis(700);
/// Even with nonstop speech, the segment closes at this limit.
const MAX_SEGMENT: usize = SAMPLE_RATE * 14;
/// Below this we consider it silence.
const SILENCE_RMS: f32 = 0.006;
/// 20 ms frame: the unit in which we ask "is there voice here?".
const QUADRO: usize = SAMPLE_RATE / 50;
/// Minimum fraction of the segment with speech energy for the model to be worth
/// running. It used to be just the RMS of the whole segment, which is why the
/// hallucination got through: 14 s of silence with one keystroke in the middle
/// average above the threshold, and Whisper fills the void with what it saw most
/// in training — YouTube captions asking for likes and subscriptions.
const MIN_FRACAO_FALA: f32 = 0.08;
/// And an absolute floor: less than 250 ms of voice is no word at all.
const MIN_MS_FALA: usize = 250;
/// Slack kept around the speech when trimming the ends, in frames.
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
            .map_err(|e| anyhow::anyhow!("{}: {e}", tr("não consegui carregar o modelo", "couldn't load the model")))?;
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
        p.set_no_context(true);       // each window is independent: avoids hallucination loops
        p.set_single_segment(false);
        p.set_suppress_blank(true);
        p.set_suppress_nst(true);     // suppresses non-speech tokens
        p.set_temperature(0.0);
        p.set_no_speech_thold(0.6);
        p.set_print_special(false);
        p.set_print_progress(false);
        p.set_print_realtime(false);
        p.set_print_timestamps(false);
        p
    }

    fn transcribe(&self, audio: &[f32]) -> anyhow::Result<String> {
        // pad to 1 s, otherwise whisper.cpp refuses
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
            .map_err(|e| anyhow::anyhow!("{}: {e}", tr("estado do whisper", "whisper state")))?;
        state
            .full(self.params(), audio)
            .map_err(|e| anyhow::anyhow!("{}: {e}", tr("falha na inferência", "inference failed")))?;

        let mut out = String::new();
        for seg in state.as_iter() {
            // drop segments the model itself considers silence
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

/// Folds accents and case and drops punctuation: the hallucination arrives
/// decorated and different every time ("Não se esqueça de se inscrever no canal!"),
/// so the comparison has to be on a single form.
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

/// Removes markers ([MÚSICA], (risos)) and typical silence hallucinations.
fn clean(s: &str) -> String {
    let mut t = s.trim().to_string();

    // short markers in brackets or parentheses
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

    // Short standalone phrases: Whisper returns these when it hears only silence.
    // Exact equality, because "obrigado" in the middle of a sentence is real speech.
    const LIXO: [&str; 9] = [
        "you", "thank you", "obrigado", "obrigada", "tchau",
        "legendas pela comunidade amara org", "amara org",
        "legendas pela comunidade", "subtitles by the amara org community",
    ];
    if key.is_empty() || LIXO.contains(&key.as_str()) {
        return String::new();
    }

    // Whisper's Portuguese training is full of YouTube captions, and the average
    // video ends asking for likes and subscriptions. It makes these up over
    // silence and fan noise, always worded differently — so we match by
    // content, not equality. The price is that these phrases can't be dictated
    // on purpose, and dictating "deixa o like" to a shell is not a use case
    // that exists.
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
        // Whisper produced every one of these over silence at some point.
        for frase in [
            "Se inscreva no canal e deixe o seu like!",
            "Não se esqueça de se inscrever no canal.",
            "Inscreva-se no canal, ative o sininho.",
            "Obrigado por assistir, até o próximo vídeo!",
            "deixa o like aí galera",
        ] {
            assert_eq!(clean(frase), "", "got through: {frase}");
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
        // "like" and "canal" outside the catchphrase still get through.
        let s = "gostei do canal de áudio novo";
        assert_eq!(clean(s), s);
    }
}

#[cfg(test)]
mod portao {
    use super::*;

    /// A segment of `ms` milliseconds, with speech in the milliseconds of `fala`.
    fn trecho(ms: usize, fala: std::ops::Range<usize>) -> Vec<f32> {
        (0..SAMPLE_RATE * ms / 1000)
            .map(|i| {
                let t = i * 1000 / SAMPLE_RATE;
                // A wave well above the threshold where there is speech; zero elsewhere.
                if fala.contains(&t) { if i % 2 == 0 { 0.3 } else { -0.3 } } else { 0.0 }
            })
            .collect()
    }

    #[test]
    fn silencio_com_um_estalo_nao_abre_o_portao() {
        // The hallucination case: 14 s of nothing with 40 ms of noise in the middle.
        let a = trecho(14_000, 7_000..7_040);
        assert!(super::rms(&a) >= SILENCE_RMS, "the old gate would open here");
        assert!(!tem_fala(&a), "the new gate must stay closed");
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
        // What remains is the speech plus the slack at both ends, not the 5 s.
        let esperado = SAMPLE_RATE * 500 / 1000 + 2 * FOLGA_QUADROS * QUADRO;
        assert!(corte.len() <= esperado, "trimmed too little: {}", corte.len());
        assert!(corte.len() >= SAMPLE_RATE * 500 / 1000, "trimmed speech: {}", corte.len());
        // And what remains is still speech as far as the gate is concerned.
        assert!(tem_fala(corte));
    }
}

fn rms(x: &[f32]) -> f32 {
    if x.is_empty() {
        return 0.0;
    }
    (x.iter().map(|v| v * v).sum::<f32>() / x.len() as f32).sqrt()
}

/// Is it worth running the model on this segment? Counts voiced frames instead
/// of the average RMS: a stray 40 ms click in silence raises the average enough
/// for the old gate to open, and what comes out of that is hallucination.
fn tem_fala(audio: &[f32]) -> bool {
    let total = audio.len() / QUADRO;
    if total == 0 {
        return false;
    }
    let com_voz = audio.chunks_exact(QUADRO).filter(|q| rms(q) >= SILENCE_RMS).count();
    com_voz * 20 >= MIN_MS_FALA && com_voz as f32 / total as f32 >= MIN_FRACAO_FALA
}

/// Trims the silence at the ends, leaving some slack. A trailing silence is an
/// invitation to hallucinate: the model keeps "transcribing" what isn't there,
/// and fills it with video captions. Silence in the middle stays — it is a pause
/// between words, and removing it would glue together phrases not said together.
fn recortar(audio: &[f32]) -> &[f32] {
    let voz: Vec<bool> = audio.chunks_exact(QUADRO).map(|q| rms(q) >= SILENCE_RMS).collect();
    let Some(a) = voz.iter().position(|&v| v) else { return &[] };
    let b = voz.iter().rposition(|&v| v).unwrap_or(a);
    let ini = a.saturating_sub(FOLGA_QUADROS) * QUADRO;
    let fim = ((b + 1 + FOLGA_QUADROS) * QUADRO).min(audio.len());
    &audio[ini..fim]
}

/// Main loop: consumes audio until the stop signal.
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
        // drain everything that arrived
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
            // only run the model if there was real speech in the segment
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

    // close whatever is left in the buffer
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

    /// Transcribes a known audio with a real model.
    /// Skipped if the `tiny` model hasn't been downloaded yet.
    #[test]
    fn transcreve_audio_real() {
        let modelo = dirs_modelo_tiny();
        let wav = std::path::Path::new("/tmp/jfk.wav");
        if !modelo.exists() || !wav.exists() {
            eprintln!("skipping: model or test audio missing");
            return;
        }

        let audio = ler_wav_16k_mono(wav);
        assert!(audio.len() > SAMPLE_RATE, "audio too short");

        let eng = Engine::load(modelo.to_str().unwrap(), "en").expect("load model");
        let texto = eng.transcribe(&audio).expect("transcribe").to_lowercase();

        eprintln!("transcribed: {texto}");
        assert!(texto.contains("ask not what your country"), "got: {texto}");
    }

    fn dirs_modelo_tiny() -> std::path::PathBuf {
        std::path::PathBuf::from(std::env::var("HOME").unwrap())
            .join("Library/Application Support/ai.dimenso.escuta/models/ggml-tiny.bin")
    }

    /// Minimal reader for 16-bit PCM mono 16 kHz WAV.
    fn ler_wav_16k_mono(p: &std::path::Path) -> Vec<f32> {
        let b = std::fs::read(p).expect("read wav");
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
                assert_eq!((ch, sr, bits), (1, 16_000, 16), "expected mono 16k 16-bit");
            } else if id == b"data" {
                return body
                    .chunks_exact(2)
                    .map(|s| i16::from_le_bytes([s[0], s[1]]) as f32 / 32768.0)
                    .collect();
            }
            i += 8 + sz + (sz & 1);
        }
        panic!("chunk 'data' not found");
    }
}
