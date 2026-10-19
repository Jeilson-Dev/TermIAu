//! Microphone capture via cpal, converted to mono 16 kHz f32.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::Arc;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::SampleFormat;

use crate::resample::Resampler;
use crate::stt::SAMPLE_RATE;
use crate::language::tr;

#[derive(serde::Serialize)]
pub struct DeviceInfo {
    pub name: String,
    pub default: bool,
}

fn device_name(d: &cpal::Device) -> String {
    d.description()
        .map(|desc| desc.name().to_string())
        .unwrap_or_else(|_| tr("desconhecido", "unknown").into())
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
        .ok_or_else(|| anyhow::anyhow!(tr("nenhum microfone disponível", "no microphone available")))
}

/// Opens the microphone and feeds `audio_tx` with mono 16 kHz blocks.
/// `level_tx` receives the level (0..1) for the UI meter.
///
/// `cpal::Stream` is not `Send`, so it must be born and die on this thread:
/// the function blocks until `stop` becomes true.
pub fn capture(
    device_name: Option<String>,
    audio_tx: Sender<Vec<f32>>,
    level_tx: Sender<f32>,
    stop: Arc<AtomicBool>,
) -> anyhow::Result<()> {
    let device = pick(device_name.as_deref())?;
    let supported = device
        .default_input_config()
        .map_err(|e| anyhow::anyhow!("{}: {e}", tr("configuração do microfone", "microphone configuration")))?;

    let in_rate = supported.sample_rate();
    let channels = supported.channels() as usize;
    let sample_format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();

    let mut resampler = Resampler::new(in_rate, SAMPLE_RATE as u32);

    // Downmix to mono, resample and send. Runs inside the audio callback.
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

    let err_fn = |e| eprintln!("[audio] stream error: {e}");

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
        other => return Err(anyhow::anyhow!("{}: {other:?}", tr("formato de áudio não suportado", "unsupported audio format"))),
    }
    .map_err(|e| anyhow::anyhow!("{}: {e}", tr("não consegui abrir o microfone", "couldn't open the microphone")))?;

    stream
        .play()
        .map_err(|e| anyhow::anyhow!("{}: {e}", tr("não consegui iniciar a captura", "couldn't start capturing")))?;

    while !stop.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(100));
    }
    drop(stream); // closes the device here, on the owning thread
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Lists real microphones through CoreAudio and checks the default shows up.
    #[test]
    fn lists_microphones() {
        let devs = list_devices();
        for d in &devs {
            eprintln!("mic: {} {}", d.name, if d.default { "(default)" } else { "" });
            assert!(!d.name.is_empty());
        }
        if !devs.is_empty() {
            assert_eq!(devs.iter().filter(|d| d.default).count(), 1, "expected one default");
        }
    }

    /// Picking by name must find the device; an unknown name falls back to the default.
    #[test]
    fn picks_by_name() {
        let devs = list_devices();
        let Some(first) = devs.first() else { return };
        let d = pick(Some(&first.name)).expect("find by name");
        assert_eq!(device_name(&d), first.name);
        assert!(pick(Some("microphone that does not exist")).is_ok(), "should fall back to the default");
    }
}
