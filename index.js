import { clamp01, mulberry32 } from 'kazu';
// synthkit — pure, deterministic, headless-testable procedural audio engine.
//
// GOAL: describe sound as PLAIN DATA (a "synth spec") and turn it into either
//   (a) an offline sample buffer (Float32Array) — synthesized in pure JS with
//       no audio hardware, so it is fully headless-TESTABLE (FFT / RMS / peak
//       analysis stands in for "listening"); or
//   (b) live Web Audio nodes in a browser (M4 — see DESIGN.md).
//
// The same spec drives both paths: minimal primitives (oscillator, ADSR,
// filter, sequencer) that COMBINE into melodies, arps, progressions and SFX.
//
// DETERMINISTIC: no Math.random. Noise (M1+) uses a seeded PRNG, so every
// render is byte-reproducible and therefore unit-testable.
//
// RENDERER-AGNOSTIC: no DOM / AudioContext import. Inputs are plain numbers
// and a plain-data spec; OUTPUT (offline) is a Float32Array of mono samples in
// [-1, 1]. The host (a game, a test, a Node script) decides what to do with it.
//
// This file is the M1 core: oscillator (sine/saw/square/triangle) through an
// ADSR envelope → Float32Array, plus equal-temperament note(name)→Hz. The
// sequencer, filters and Web-Audio connect() are planned for M2+.

// ---------------------------------------------------------------------------
// Music theory — note(name) → frequency (Hz). Equal temperament, A4 = 440 Hz.
// ---------------------------------------------------------------------------

// semitone offset of each pitch class from C within an octave
const PITCH_CLASS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

// note('A4') → 440, note('C#5'), note('Eb3'), note('A#4')… also accepts a
// number (already-Hz) for convenience so specs can pass either.
export function note(name) {
  if (typeof name === 'number') return name;
  const m = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(String(name).trim());
  if (!m) throw new Error(`synthkit: bad note name "${name}"`);
  const [, letter, accidental, octStr] = m;
  let semitone = PITCH_CLASS[letter.toUpperCase()];
  if (accidental === '#') semitone += 1;
  else if (accidental === 'b') semitone -= 1;
  const octave = parseInt(octStr, 10);
  // MIDI-style absolute semitone index; A4 (MIDI 69) is the 440 Hz anchor.
  const midi = (octave + 1) * 12 + semitone;
  return 440 * Math.pow(2, (midi - 69) / 12);
}

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32) — for noise oscillators. No Math.random anywhere.
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Oscillators — one sample of a band-naive waveform at phase p ∈ [0, 1).
// (Naive saw/square alias at high pitch; M2 will add PolyBLEP. Fine for M1.)
// ---------------------------------------------------------------------------
const TAU = Math.PI * 2;

function oscSample(type, phase, rng) {
  switch (type) {
    case 'sine':     return Math.sin(phase * TAU);
    case 'saw':      return 2 * (phase - Math.floor(phase + 0.5));   // -1..1 ramp
    case 'square':   return phase < 0.5 ? 1 : -1;
    case 'triangle': return 4 * Math.abs(phase - Math.floor(phase + 0.5)) - 1;
    case 'noise':    return rng() * 2 - 1;
    default: throw new Error(`synthkit: unknown osc type "${type}"`);
  }
}

// Coerce a numeric option to a finite value: NaN / Infinity / non-numbers fall
// back to `def`, finite values are clamped to [min, max]. Bounds are the
// physically meaningful range of audio sample rates / durations, so a spec
// cannot drive `render` into an unbounded buffer allocation (DoS) — the buffer
// length is `sampleRate * (duration + release)`, so a hostile or malformed
// `sampleRate: 1e9, duration: 1` would otherwise allocate ~4.4 GB and spin the
// render loop until the host is killed.
function finiteOpt(x, def, min, max) {
  if (typeof x !== 'number' || !Number.isFinite(x)) return def;
  return Math.min(max, Math.max(min, x));
}

// ---------------------------------------------------------------------------
// ADSR envelope — amplitude ∈ [0, 1] at time t (seconds), given a note that is
// held for `duration` seconds. attack→decay→sustain (held) then release.
// ---------------------------------------------------------------------------
// Envelope value during the HELD phase (attack → decay → sustain), independent
// of when the note is released. Factored out so the release ramp can start from
// the value the envelope actually held at note-off (t = duration), not from the
// sustain level — which keeps the amplitude continuous across the release
// boundary even when the note is released during attack or decay.
function heldAmp(a, d, s, t) {
  if (t < a) return a > 0 ? t / a : 1;                       // attack: 0 → 1
  if (t < a + d) return d > 0 ? 1 - (1 - s) * ((t - a) / d) : s; // decay: 1 → s
  return s;                                                  // sustain: hold at s
}

function adsrAmp(env, t, duration) {
  const a = env.attack  ?? 0.01;
  const d = env.decay   ?? 0.05;
  const s = clamp01(env.sustain ?? 0.7); // sustain LEVEL (0..1), not a time
  const r = env.release ?? 0.1;

  if (t < 0) return 0;
  // Release begins at note-off (t = duration). The release ramp anchors on the
  // amplitude held at that instant (attack/decay/sustain value), so the envelope
  // is continuous across the boundary regardless of which phase was active.
  if (t >= duration) {
    const amp0 = heldAmp(a, d, s, duration);
    const rt = t - duration;                             // release: amp0 → 0
    if (rt < r) return r > 0 ? amp0 * (1 - rt / r) : 0;
    return 0;
  }
  return heldAmp(a, d, s, t);
}

// total tail length of a note = its held duration + its release time.
function noteTail(env, duration) {
  return duration + (env.release ?? 0.1);
}

// ---------------------------------------------------------------------------
// render(spec, opts) → Float32Array  [M1 core, PURE / OFFLINE]
//
// spec: {
//   osc:   'sine' | 'saw' | 'square' | 'triangle' | 'noise'   (default 'sine')
//   freq:  number(Hz) | note-name (e.g. 'A4')                 (default 'A4')
//   env:   { attack, decay, sustain, release } (seconds; sustain is a LEVEL)
//   gain:  output level 0..1                                  (default 0.9)
//   seed:  integer, only used by the 'noise' oscillator       (default 1)
// }
// opts: { sampleRate = 44100, duration = <note hold seconds> }
//   `duration` is how long the note is HELD; the buffer is extended to include
//   the envelope release tail, so the output is `duration + release` long.
// ---------------------------------------------------------------------------
export function render(spec = {}, opts = {}) {
  const sampleRate = finiteOpt(opts.sampleRate, 44100, 1, 192000);
  const hold = finiteOpt(opts.duration, 0.3, 0, 3600);  // seconds the note is held
  const env = spec.env ?? {};
  const gain = clamp01(spec.gain ?? 0.9);
  const type = spec.osc ?? 'sine';
  const freq = note(spec.freq ?? 'A4');
  const rng = mulberry32((spec.seed ?? 1) >>> 0);

  const totalSec = noteTail(env, hold);
  const n = Math.max(1, Math.round(sampleRate * totalSec));
  const out = new Float32Array(n);

  const dPhase = freq / sampleRate;             // phase increment per sample
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const amp = adsrAmp(env, t, hold);
    out[i] = oscSample(type, phase, rng) * amp * gain;
    phase += dPhase;
    if (phase >= 1) phase %= 1;                 // wrap to [0,1) — single subtract only handles dPhase < 2; modulo covers freq >= sampleRate so the oscillator doesn't collapse
  }
  return out;
}

// ---------------------------------------------------------------------------
// TODO (M2) — sequencer + music helpers:
//   export function scale(root, mode)        → [Hz, …]
//   export function chord(root, quality)     → [Hz, …]
//   export function progression(key, roman)  → [[Hz…], …]
//   export function sequence(spec, opts)     → Float32Array  (notes over time)
// TODO (M2) — filters: lowpass(buf, cutoff, sr) / highpass(...) (one-pole/biquad)
// TODO (M3) — SFX presets: clack / riichi / tsumo / ron / doraFlip (intensity, pitch)
// TODO (M4) — live Web Audio:
//   export function connect(spec, audioContext) → { output: AudioNode, start, stop }
//   (build OscillatorNode → GainNode(ADSR via setValueAtTime) → BiquadFilter →
//    destination; same spec as render(), so offline tests guard the live path.)
// ---------------------------------------------------------------------------
