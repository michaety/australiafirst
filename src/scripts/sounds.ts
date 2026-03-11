let _ctx: AudioContext | null = null;
function ac(): AudioContext {
  if (!_ctx) _ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
  return _ctx;
}

export function playBeep(): void {
  const a = ac();
  const osc = a.createOscillator(); const g = a.createGain();
  osc.connect(g); g.connect(a.destination);
  osc.type = 'square'; osc.frequency.value = 440;
  g.gain.setValueAtTime(0.12, a.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + 0.08);
  osc.start(a.currentTime); osc.stop(a.currentTime + 0.08);
}

export function playSwipe(): void {
  const a = ac();
  const osc = a.createOscillator(); const g = a.createGain();
  osc.connect(g); g.connect(a.destination);
  osc.type = 'sine';
  osc.frequency.setValueAtTime(200, a.currentTime);
  osc.frequency.exponentialRampToValueAtTime(100, a.currentTime + 0.12);
  g.gain.setValueAtTime(0.16, a.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + 0.12);
  osc.start(a.currentTime); osc.stop(a.currentTime + 0.12);
}

export function playAlert(): void {
  const a = ac();
  [0, 0.12].forEach(d => {
    const osc = a.createOscillator(); const g = a.createGain();
    osc.connect(g); g.connect(a.destination);
    osc.type = 'square'; osc.frequency.value = 880;
    g.gain.setValueAtTime(0.1, a.currentTime + d);
    g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + d + 0.07);
    osc.start(a.currentTime + d); osc.stop(a.currentTime + d + 0.07);
  });
}

export function playError(): void {
  const a = ac();
  const osc = a.createOscillator(); const g = a.createGain();
  osc.connect(g); g.connect(a.destination);
  osc.type = 'sawtooth'; osc.frequency.value = 150;
  g.gain.setValueAtTime(0.2, a.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + 0.2);
  osc.start(a.currentTime); osc.stop(a.currentTime + 0.2);
}

// Expose globally for non-module scripts
if (typeof window !== 'undefined') {
  (window as any).__sounds = { playBeep, playSwipe, playAlert, playError };
}
