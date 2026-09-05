//! Reamostragem por sinc janelado (Blackman). Qualquer razão de taxas,
//! qualidade muito acima do que se precisa aqui, sem dependências.
//!
//! Serve as duas pontas: o microfone descendo para os 16 kHz do Whisper e a
//! voz subindo dos 24 kHz do Kokoro para a taxa da placa de som.

const TAPS: isize = 24; // meia-largura do kernel

pub struct Resampler {
    ratio: f64,   // in_rate / out_rate — passo no espaço de entrada
    cutoff: f64,  // frequência de corte normalizada (Nyquist da menor taxa)
    hist: Vec<f32>,
    pos: f64,     // posição de leitura, em amostras de entrada, dentro de `hist`
}

impl Resampler {
    pub fn new(in_rate: u32, out_rate: u32) -> Self {
        let ratio = in_rate as f64 / out_rate as f64;
        Self {
            ratio,
            cutoff: if ratio > 1.0 { 1.0 / ratio } else { 1.0 },
            hist: Vec::new(),
            pos: TAPS as f64,
        }
    }

    /// Consome amostras mono e devolve as amostras já na taxa de saída.
    pub fn process(&mut self, input: &[f32]) -> Vec<f32> {
        self.hist.extend_from_slice(input);

        let limit = self.hist.len() as f64 - TAPS as f64;
        let mut out = Vec::with_capacity((input.len() as f64 / self.ratio) as usize + 2);

        while self.pos < limit {
            let center = self.pos.floor() as isize;
            let frac = self.pos - center as f64;
            let mut acc = 0.0f64;
            let mut norm = 0.0f64;

            for k in -TAPS..=TAPS {
                let idx = center + k;
                if idx < 0 || idx as usize >= self.hist.len() {
                    continue;
                }
                let x = k as f64 - frac;
                let w = blackman(x);
                let s = sinc(x * self.cutoff) * self.cutoff * w;
                acc += self.hist[idx as usize] as f64 * s;
                norm += s;
            }

            out.push(if norm.abs() > 1e-9 { (acc / norm) as f32 } else { 0.0 });
            self.pos += self.ratio;
        }

        // descarta o histórico já consumido, mantendo margem para o kernel
        let keep_from = (self.pos.floor() as isize - TAPS).max(0) as usize;
        if keep_from > 0 {
            self.hist.drain(..keep_from);
            self.pos -= keep_from as f64;
        }
        out
    }
}

fn sinc(x: f64) -> f64 {
    if x.abs() < 1e-9 {
        1.0
    } else {
        let p = std::f64::consts::PI * x;
        p.sin() / p
    }
}

fn blackman(x: f64) -> f64 {
    let n = TAPS as f64;
    if x.abs() > n {
        return 0.0;
    }
    // janela de Blackman centrada em 0, largura 2n
    let t = std::f64::consts::PI * (x + n) / n;
    0.42 - 0.5 * (t).cos() + 0.08 * (2.0 * t).cos()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Um seno de 440 Hz reamostrado 48k→16k deve continuar sendo um seno de 440 Hz.
    #[test]
    fn preserva_tom_puro() {
        let mut r = Resampler::new(48_000, 16_000);
        let input: Vec<f32> = (0..48_000)
            .map(|i| (2.0 * std::f64::consts::PI * 440.0 * i as f64 / 48_000.0).sin() as f32)
            .collect();
        let out = r.process(&input);

        // ~1s de áudio a 16 kHz (com folga do kernel)
        assert!(out.len() > 15_900 && out.len() <= 16_000, "len = {}", out.len());

        // A leitura começa em `TAPS` amostras de entrada (o kernel precisa de
        // histórico), o que dá uma latência fixa de TAPS/ratio amostras na saída.
        let lag = TAPS as f64 / 3.0; // 48k->16k
        let start = 200;
        let err: f64 = out[start..out.len() - 200]
            .iter()
            .enumerate()
            .map(|(i, &v)| {
                let k = (i + start) as f64 + lag;
                let want = (2.0 * std::f64::consts::PI * 440.0 * k / 16_000.0).sin();
                (v as f64 - want).abs()
            })
            .sum::<f64>()
            / (out.len() - 400) as f64;
        assert!(err < 0.02, "erro médio {err}");
    }

    /// Chamadas em blocos pequenos devem dar o mesmo resultado que um bloco só.
    #[test]
    fn streaming_bate_com_lote() {
        let input: Vec<f32> = (0..9_600)
            .map(|i| (i as f32 * 0.01).sin() * 0.5)
            .collect();

        let lote = Resampler::new(48_000, 16_000).process(&input);

        let mut r = Resampler::new(48_000, 16_000);
        let mut stream = Vec::new();
        for chunk in input.chunks(512) {
            stream.extend(r.process(chunk));
        }

        assert_eq!(lote.len(), stream.len());
        for (a, b) in lote.iter().zip(&stream) {
            assert!((a - b).abs() < 1e-6);
        }
    }
}
