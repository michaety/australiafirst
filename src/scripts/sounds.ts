// ── Preload audio files ────────────────────────────────────────────────────

const CLIP_DURATION = 2; // seconds — hard cap for any file that's too long

function makeSound(path: string, volume = 1.0) {
  if (typeof window === 'undefined') return null;
  const audio = new Audio(path);
  audio.load();
  return { audio, volume };
}

function play(sfx: ReturnType<typeof makeSound>, startAt = 0) {
  if (!sfx?.audio) return;
  try {
    const clone = sfx.audio.cloneNode() as HTMLAudioElement;
    clone.volume = sfx.volume;
    clone.currentTime = startAt;
    clone.play().catch(() => {});
    // Stop after CLIP_DURATION so long files don't keep playing
    setTimeout(() => {
      clone.pause();
      clone.currentTime = 0;
    }, CLIP_DURATION * 1000);
  } catch {}
}

const SFX = typeof window !== 'undefined' ? {
  chirp1:        makeSound('/sounds/teletype-chirp.wav',  0.35), // harsh — sparingly
  chirp2:        makeSound('/sounds/teletype-chirp2.mp3', 0.45), // softer — plays once, rides out
  alert:         makeSound('/sounds/alert.wav',           0.6),
  error:         makeSound('/sounds/error-buzz.wav',      0.7),
  swipe:         makeSound('/sounds/swipe.wav',           0.5),
  accessGranted: makeSound('/sounds/access-granted.wav',  0.7),
} : null;

// ── Chirp2 "ride" logic ────────────────────────────────────────────────────
// chirp2 is 9 seconds long — we start it playing on the first keypress
// and let it ride for up to 2 seconds. We don't re-trigger it per keypress,
// just occasionally when it's not already playing.

let chirp2Active = false;
let chirp2Timer: ReturnType<typeof setTimeout> | null = null;

function playChirp2Ride() {
  if (chirp2Active || !SFX?.chirp2?.audio) return;
  chirp2Active = true;
  try {
    const clone = SFX.chirp2.audio.cloneNode() as HTMLAudioElement;
    clone.volume = SFX.chirp2.volume;
    clone.currentTime = 0;
    clone.play().catch(() => {});
    chirp2Timer = setTimeout(() => {
      clone.pause();
      clone.currentTime = 0;
      chirp2Active = false;
    }, CLIP_DURATION * 1000);
  } catch {
    chirp2Active = false;
  }
}

// ── Exported sound functions ───────────────────────────────────────────────

/**
 * Typewriter tick — chirp2 starts and rides for 2s (not re-triggered per key).
 * chirp1 fires occasionally (~1 in 10) for texture.
 */
export function playTypeTick(): void {
  if (!SFX) return;
  // Let chirp2 ride — only restart it once it's finished
  playChirp2Ride();
  // Occasionally layer the harsher chirp1 on top
  if (Math.random() < 0.10) play(SFX.chirp1);
}

/**
 * Confirm / button click — uses swipe sound.
 */
export function playBeep(): void {
  if (!SFX) return;
  play(SFX.swipe);
}

/** Navigation / back gesture */
export function playSwipe(): void {
  if (!SFX) return;
  play(SFX.swipe);
}

/** Warning — flagged data, risk alerts */
export function playAlert(): void {
  if (!SFX) return;
  play(SFX.alert);
}

/** Error buzz */
export function playError(): void {
  if (!SFX) return;
  play(SFX.error);
}

/** Title fully typed — "access confirmed" moment */
export function playAccessGranted(): void {
  if (!SFX) return;
  play(SFX.accessGranted);
}

// Expose globally for non-module scripts
if (typeof window !== 'undefined') {
  (window as any).__sounds = { playBeep, playSwipe, playAlert, playError, playTypeTick, playAccessGranted };
}
