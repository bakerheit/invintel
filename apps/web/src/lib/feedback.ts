// Sound and vibration for scan results. The plant floor is loud and people aren't looking at the
// screen, so every outcome gets more than a colour. All of this is best effort.
let ctx: AudioContext | null = null;

function tone(freq: number, startMs: number, durationMs: number, gain = 0.18) {
  try {
    ctx ??= new AudioContext();
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.frequency.value = freq;
    amp.gain.value = gain;
    osc.connect(amp).connect(ctx.destination);
    const t = ctx.currentTime + startMs / 1000;
    osc.start(t);
    osc.stop(t + durationMs / 1000);
  } catch {
    /* no audio available */
  }
}

export function feedback(kind: "scan" | "ok" | "error") {
  if (kind === "scan") {
    tone(1200, 0, 60);
    navigator.vibrate?.(20);
  } else if (kind === "ok") {
    tone(880, 0, 90);
    tone(1320, 110, 140);
    navigator.vibrate?.([40, 40, 40]);
  } else {
    tone(220, 0, 220, 0.25);
    tone(180, 260, 300, 0.25);
    navigator.vibrate?.([200, 80, 200]);
  }
}
