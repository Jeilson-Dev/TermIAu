//! Transcrição de fala, local. Veio do app Escuta, que era um projeto à parte:
//! aqui o terminal é o único dono do microfone, da voz e da tela.
//!
//! ```text
//! cpal (microfone, taxa nativa)
//!   -> downmix para mono
//!   -> resample  (sinc janelado -> 16 kHz)
//!   -> stt       (VAD por energia + whisper.cpp com Metal)
//!   -> pty_write no painel em foco
//! ```
// O catálogo de modelos e a lista de microfones ainda não têm tela que os use.
// Ficam porque são a superfície de uns Ajustes, e apagar para ressuscitar depois
// é pior do que deixar o aviso desligado aqui.
#![allow(dead_code)]

pub mod audio;
pub mod model;
pub mod resample;
pub mod stt;
