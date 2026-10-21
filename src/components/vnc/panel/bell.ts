

export let bellContext: AudioContext | null = null;

/** RealVNC `AcceptBell`: a short beep for the RFB Bell message. */
export function playBell(): void {
  try {
    const Ctor = window.AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext; }).webkitAudioContext;
    if (!Ctor) return;
    bellContext ??= new Ctor();
    const oscillator = bellContext.createOscillator();
    const gain = bellContext.createGain();
    oscillator.frequency.value = 880;
    gain.gain.value = 0.05;
    oscillator.connect(gain).connect(bellContext.destination);
    oscillator.start();
    oscillator.stop(bellContext.currentTime + 0.1);
  } catch {
    // Audio is best effort.
  }
}
