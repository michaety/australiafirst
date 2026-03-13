// ── Preload audio files ────────────────────────────────────────────────────

const DEFAULT_CLIP = 1; // seconds — default cap for one-shot sounds

function makeSound(path: string, volume = 1.0) {
  if (typeof window === 'undefined') return null;
  const audio = new Audio(path);
  audio.load();
  return { audio, volume };
}

function play(sfx: ReturnType<typeof makeSound>, duration = DEFAULT_CLIP) {
  if (!sfx?.audio) return;
  try {
    const clone = sfx.audio.cloneNode() as HTMLAudioElement;
    clone.volume = sfx.volume;
    clone.currentTime = 0;
    clone.play().catch(() => {});
    setTimeout(() => { clone.pause(); clone.currentTime = 0; }, duration * 1000);
  } catch {}
}

const SFX = typeof window !== 'undefined' ? {
  chirp1:        makeSound('/sounds/teletype-chirp.wav',  0.35),
  chirp2:        makeSound('/sounds/teletype-chirp2.mp3', 0.45),
  alert:         makeSound('/sounds/alert.wav',           0.6),
  error:         makeSound('/sounds/error-buzz.wav',      0.7),
  swipe:         makeSound('/sounds/swipe.wav',           0.5),
  accessGranted: makeSound('/sounds/access-granted.wav',  0.7),
} : null;

// ── Audio unlock ───────────────────────────────────────────────────────────
let _unlocked = false;
let _actx: AudioContext | null = null;

function ensureUnlocked() {
  if (_unlocked) return;
  _unlocked = true;
  try {
    _actx = _actx || new (window.AudioContext || (window as any).webkitAudioContext)();
    if (_actx.state === 'suspended') _actx.resume();
    if (SFX) {
      Object.values(SFX).forEach(s => {
        if (!s?.audio) return;
        s.audio.play().then(() => { s.audio.pause(); s.audio.currentTime = 0; }).catch(() => {});
      });
    }
  } catch {}
}

export function unlockAudio(): void { ensureUnlocked(); }

if (typeof document !== 'undefined') {
  // Try immediately — works if browser allows autoplay or user has prior interaction with site
  ensureUnlocked();
  const unlock = () => { ensureUnlocked(); ['click','touchstart','keydown'].forEach(e => document.removeEventListener(e, unlock)); };
  ['click','touchstart','keydown'].forEach(e => document.addEventListener(e, unlock, { passive: true }));
}

// ── Ride logic ─────────────────────────────────────────────────────────────
// Plays a clip once and blocks re-trigger for `duration` ms.

function createRide(sfx: ReturnType<typeof makeSound>, duration: number) {
  let active = false;
  return () => {
    if (active || !sfx?.audio) return;
    active = true;
    try {
      const clone = sfx.audio.cloneNode() as HTMLAudioElement;
      clone.volume = sfx.volume;
      clone.currentTime = 0;
      clone.play().catch(() => {});
      setTimeout(() => { clone.pause(); clone.currentTime = 0; active = false; }, duration * 1000);
    } catch { active = false; }
  };
}

// Splash: chirp1 rides for 0.9s then can re-trigger — fires ~3 times during tagline (~2.4s).
const rideSplash      = SFX ? createRide(SFX.chirp1, 0.9) : () => {};

// Profile name: chirp1 short burst (0.35s) — cycles through a ~1s name reveal
const rideProfileName = SFX ? createRide(SFX.chirp1, 0.35) : () => {};

// Profile days: chirp2 short burst (0.35s) — cycles through a ~0.6s days reveal
const rideProfileDays = SFX ? createRide(SFX.chirp2, 0.35) : () => {};

// ── Exported sound functions ───────────────────────────────────────────────

/** Splash-page typewriter — chirp1 ride at 0.8s intervals */
export function playTypeTick(): void { if (SFX) rideSplash(); }

/** Profile name typewriter — chirp1 short burst */
export function playTypeTickName(): void { if (SFX) rideProfileName(); }

/** Profile days-in-office typewriter — chirp2 short burst */
export function playTypeTickDays(): void { if (SFX) rideProfileDays(); }

/** Confirm / button click */
export function playBeep(): void { if (SFX) play(SFX.swipe, 0.6); }

/** Navigation / back gesture */
export function playSwipe(): void { if (SFX) play(SFX.swipe, 0.6); }

/** Warning — flagged data, risk alerts */
export function playAlert(): void { if (SFX) play(SFX.alert); }

/** Error buzz */
export function playError(): void { if (SFX) play(SFX.error); }

/** Title fully typed — "access confirmed" moment */
export function playAccessGranted(): void { if (SFX) play(SFX.accessGranted); }

// Expose globally for non-module scripts (profile page define:vars scripts)
if (typeof window !== 'undefined') {
  (window as any).__sounds = {
    playBeep, playSwipe, playAlert, playError,
    playTypeTick, playTypeTickName, playTypeTickDays, playAccessGranted, unlockAudio,
  };
}
