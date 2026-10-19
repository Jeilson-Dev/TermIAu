# Dictation — a TermIAu plugin

Speak instead of typing. `⌘E` (or **Dictation ▸ Listen**) opens the microphone; the
footer's left end shows a pink wave and the partial text while you speak. Each
finished sentence is typed into the focused panel, and after five seconds of silence
it is sent with Enter — typing anything cancels that countdown. A minute without
speaking turns listening off.

Transcription is local: whisper.cpp with Metal, the `small` model (466 MB),
downloaded once into `~/.termiau/plugin-data/termiau.dictation/models/`. A model
TermIAu downloaded while dictation was part of the app is reused from where it is.

## How it is built

- `engine/` — a Rust crate, the binary `termiau-dictation`: microphone capture
  (cpal), resampling to 16 kHz, a speech gate and whisper.cpp. TermIAu runs it as
  the plugin's process and speaks newline-delimited JSON with it (the protocol is at
  the top of `engine/src/main.rs`).
- `src/main.ts` — the plugin: the footer strip, the countdown, writing into the
  focused panel (`ctx.terminal`), and the engine (`ctx.process.spawn("engine")`).
- `termiau.json` — declares the binary, the platform (`darwin-arm64`), the footer
  slot on the left and the `⌘E` command.

The plugin ships native code, so it must be signed by a publisher TermIAu trusts:
`npm run plugin:dictation` builds the engine in release, signs it ad hoc for macOS,
and signs the package with the key from `scripts/signing-key.sh`.

macOS asks for the microphone once, in TermIAu's name: the engine is a child of the
app, and the permission text is in the app's `Info.plist`.
