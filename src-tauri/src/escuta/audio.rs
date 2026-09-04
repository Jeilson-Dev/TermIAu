//! Captura do microfone via cpal, convertida para mono 16 kHz f32.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::Arc;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::SampleFormat;

use super::resample::Resampler;
use super::stt::SAMPLE_RATE;

#[derive(serde::Serialize)]
pub struct DeviceInfo {
    pub name: String,
    pub default: bool,
}

fn device_name(d: &cpal::Device) -> String {
    d.description()
        .map(|desc| desc.name().to_string())
        .unwrap_or_else(|_| "desconhecido".into())
}

pub fn list_devices() -> Vec<DeviceInfo> {
    let host = cpal::default_host();
    let default = host.default_input_device().map(|d| device_name(&d));
    host.input_devices()
        .map(|it| {
            it.map(|d| {
                let name = device_name(&d);
                DeviceInfo { default: Some(&name) == default.as_ref(), name }
            })
            .collect()
        })
        .unwrap_or_default()
}

fn pick(name: Option<&str>) -> anyhow::Result<cpal::Device> {
    let host = cpal::default_host();
    if let Some(want) = name {
        if let Ok(mut it) = host.input_devices() {
            if let Some(d) = it.find(|d| device_name(d) == want) {
                return Ok(d);
            }
        }
    }
    host.default_input_device()
        .ok_or_else(|| anyhow::anyhow!("nenhum microfone disponível"))
}

/// Abre o microfone e alimenta `audio_tx` com blocos mono a 16 kHz.
/// `level_tx` recebe o nível (0..1) para o medidor da interface.
///
/// O `cpal::Stream` não é `Send`, então precisa nascer e morrer nesta thread:
/// a função bloqueia até `stop` virar true.
pub fn capture(
    device_name: Option<String>,
    audio_tx: Sender<Vec<f32>>,
    level_tx: Sender<f32>,
    stop: Arc<AtomicBool>,
) -> anyhow::Result<()> {
    let device = pick(device_name.as_deref())?;
    let supported = device
        .default_input_config()
        .map_err(|e| anyhow::anyhow!("configuração do microfone: {e}"))?;

    let in_rate = supported.sample_rate();
    let channels = supported.channels() as usize;
    let sample_format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();

    let mut resampler = Resampler::new(in_rate, SAMPLE_RATE as u32);

    // Downmix para mono, reamostra e envia. Roda dentro do callback de áudio.
    let mut feed = move |samples: &[f32]| {
        let mono: Vec<f32> = if channels <= 1 {
            samples.to_vec()
        } else {
            samples
                .chunks(channels)
                .map(|f| f.iter().sum::<f32>() / channels as f32)
                .collect()
        };
        if mono.is_empty() {
            return;
        }
        let peak = mono.iter().fold(0.0f32, |m, v| m.max(v.abs()));
        let _ = level_tx.send(peak);

        let out = resampler.process(&mono);
        if !out.is_empty() {
            let _ = audio_tx.send(out);
        }
    };

    let err_fn = |e| eprintln!("[audio] erro no stream: {e}");

    let stream = match sample_format {
        SampleFormat::F32 => device.build_input_stream(
            config,
            move |d: &[f32], _: &_| feed(d),
            err_fn,
            None,
        ),
        SampleFormat::I16 => device.build_input_stream(
            config,
            move |d: &[i16], _: &_| {
                let f: Vec<f32> = d.iter().map(|&s| s as f32 / i16::MAX as f32).collect();
                feed(&f)
            },
            err_fn,
            None,
        ),
        SampleFormat::U16 => device.build_input_stream(
            config,
            move |d: &[u16], _: &_| {
                let f: Vec<f32> = d
                    .iter()
                    .map(|&s| (s as f32 - 32768.0) / 32768.0)
                    .collect();
                feed(&f)
            },
            err_fn,
            None,
        ),
        other => return Err(anyhow::anyhow!("formato de áudio não suportado: {other:?}")),
    }
    .map_err(|e| anyhow::anyhow!("não consegui abrir o microfone: {e}"))?;

    stream
        .play()
        .map_err(|e| anyhow::anyhow!("não consegui iniciar a captura: {e}"))?;

    while !stop.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(100));
    }
    drop(stream); // fecha o dispositivo aqui, na thread dona
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Enumera microfones reais pelo CoreAudio e confere que o padrão aparece.
    #[test]
    fn lista_microfones() {
        let devs = list_devices();
        for d in &devs {
            eprintln!("mic: {} {}", d.name, if d.default { "(padrão)" } else { "" });
            assert!(!d.name.is_empty());
        }
        if !devs.is_empty() {
            assert_eq!(devs.iter().filter(|d| d.default).count(), 1, "esperava um padrão");
        }
    }

    /// A escolha por nome deve achar o dispositivo; nome inexistente cai no padrão.
    #[test]
    fn escolhe_por_nome() {
        let devs = list_devices();
        let Some(first) = devs.first() else { return };
        let d = pick(Some(&first.name)).expect("achar por nome");
        assert_eq!(device_name(&d), first.name);
        assert!(pick(Some("microfone que não existe")).is_ok(), "deveria cair no padrão");
    }
}
