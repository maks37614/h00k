// Web Audio API sound for price alerts.

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  try {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextClass) return null;
    if (!audioCtx || audioCtx.state === 'closed') {
      audioCtx = new AudioContextClass();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  } catch (e) {
    console.warn('AudioContext not available:', e);
    return null;
  }
}


/**
 * Play a distinctive 3-tone notification chime when a price alert triggers
 */
export function playAlertChime(): void {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;

    const startTime = ctx.currentTime;

    // Chord: G5 (784Hz) -> C6 (1046Hz) -> E6 (1318Hz)
    const tones = [
      { freq: 784, time: 0, dur: 0.15 },
      { freq: 1046, time: 0.08, dur: 0.18 },
      { freq: 1318, time: 0.16, dur: 0.35 },
    ];

    tones.forEach(({ freq, time, dur }) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, startTime + time);
      gain.gain.setValueAtTime(0.001, startTime + time);
      gain.gain.linearRampToValueAtTime(0.2, startTime + time + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, startTime + time + dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(startTime + time);
      osc.stop(startTime + time + dur + 0.01);
    });
  } catch (e) {
    console.warn('Failed to play alert chime:', e);
  }
}

