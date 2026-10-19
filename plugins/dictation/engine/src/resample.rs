//! Windowed-sinc (Blackman) resampling. Any rate ratio, quality far above
//! what is needed here, no dependencies.
//!
//! Takes the microphone down from the device's native rate to Whisper's
//! 16 kHz.

const TAPS: isize = 24; // kernel half-width

pub struct Resampler {
    ratio: f64,   // in_rate / out_rate — step in input space
    cutoff: f64,  // normalized cutoff frequency (Nyquist of the lower rate)
    hist: Vec<f32>,
    pos: f64,     // read position, in input samples, within `hist`
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

    /// Consumes mono samples and returns samples at the output rate.
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

        // drop the consumed history, keeping margin for the kernel
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
    // Blackman window centered on 0, width 2n
    let t = std::f64::consts::PI * (x + n) / n;
    0.42 - 0.5 * (t).cos() + 0.08 * (2.0 * t).cos()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 440 Hz sine resampled 48k→16k must still be a 440 Hz sine.
    #[test]
    fn keeps_a_pure_tone() {
        let mut r = Resampler::new(48_000, 16_000);
        let input: Vec<f32> = (0..48_000)
            .map(|i| (2.0 * std::f64::consts::PI * 440.0 * i as f64 / 48_000.0).sin() as f32)
            .collect();
        let out = r.process(&input);

        // ~1s of audio at 16 kHz (minus kernel slack)
        assert!(out.len() > 15_900 && out.len() <= 16_000, "len = {}", out.len());

        // Reading starts at `TAPS` input samples (the kernel needs history),
        // which gives a fixed latency of TAPS/ratio output samples.
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
        assert!(err < 0.02, "mean error {err}");
    }

    /// Calls in small blocks must give the same result as a single block.
    #[test]
    fn streaming_matches_batch() {
        let input: Vec<f32> = (0..9_600)
            .map(|i| (i as f32 * 0.01).sin() * 0.5)
            .collect();

        let batch = Resampler::new(48_000, 16_000).process(&input);

        let mut r = Resampler::new(48_000, 16_000);
        let mut stream = Vec::new();
        for chunk in input.chunks(512) {
            stream.extend(r.process(chunk));
        }

        assert_eq!(batch.len(), stream.len());
        for (a, b) in batch.iter().zip(&stream) {
            assert!((a - b).abs() < 1e-6);
        }
    }
}
