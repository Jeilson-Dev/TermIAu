/// Where the YouTube Radio keeps what it remembers.

/// The user's playlist, as JSON (`Item[]`, see links.ts).
export const KEY_ITEMS = "items";
/// The item on air, by `keyOf`: the index would point at another after a removal.
export const KEY_CURRENT = "current";
/// A number from 0 to 100.
export const KEY_VOLUME = "volume";
/// Whether it was on air when the app closed: it starts playing again on launch.
export const KEY_PLAYING = "playing";
