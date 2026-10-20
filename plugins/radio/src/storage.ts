/// Where the radio keeps what it remembers.

/// The current station is stored by its address, not its index: the list is
/// redone on every probe, and the index would start pointing at another.
export const KEY_STATION = "currentStation";
/// A number from 0 to 100.
export const KEY_VOLUME = "volume";
/// Whether the radio was on air when the app closed: it starts playing again on launch.
export const KEY_PLAYING = "playing";
