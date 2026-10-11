//! Local speech transcription. It came from the Escuta app, a separate project:
//! here the terminal is the sole owner of the microphone and the screen.
//!
//! ```text
//! cpal (microphone, native rate)
//!   -> downmix to mono
//!   -> resample  (windowed sinc -> 16 kHz)
//!   -> stt       (energy VAD + whisper.cpp with Metal)
//!   -> pty_write into the focused panel
//! ```
// The model catalog and the microphone list have no screen using them yet.
// They stay because they are the surface of a future Settings, and deleting them
// to bring them back later is worse than silencing the warning here.
#![allow(dead_code)]

pub mod audio;
pub mod model;
pub mod resample;
pub mod stt;
