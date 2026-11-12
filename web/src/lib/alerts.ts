const KEY = 'archstone-alert-sound';

export const soundOn = () => localStorage.getItem(KEY) !== 'off';
export const setSound = (on: boolean) => localStorage.setItem(KEY, on ? 'on' : 'off');

/** Kinds that interrupt with a pop-up. Everything else waits quietly in the bell. */
export const POPUP_KINDS = ['new_lead', 'followup', 'overdue', 'message'];

/** Two rising notes for a new lead or overdue follow-up, one for the rest. */
export function playChime(kind: string) {
  if (!soundOn()) return;
  try {
    const context = new AudioContext();
    const notes = kind === 'new_lead' || kind === 'overdue' ? [660, 880] : [660];
    notes.forEach((frequency, i) => {
      const start = context.currentTime + i * 0.18;
      const tone = context.createOscillator();
      const volume = context.createGain();
      tone.frequency.value = frequency;
      volume.gain.setValueAtTime(0.0001, start);
      volume.gain.exponentialRampToValueAtTime(0.18, start + 0.02);
      volume.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);
      tone.connect(volume).connect(context.destination);
      tone.start(start);
      tone.stop(start + 0.17);
    });
    setTimeout(() => void context.close(), 800);
  } catch {
    // A browser may refuse sound until the page is clicked. The pop-up still shows.
  }
}
