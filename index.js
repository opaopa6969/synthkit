import { clamp01, clampSym, mulberry32 } from 'kazu';
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
// ADSR envelope → Float32Array, plus equal-temperament note(name)→Hz — and the
// first M2 slice, sequence(): a list of notes/rests rendered over time. Filters,
// music-theory helpers and Web-Audio connect() are planned for M2+.

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
// scale(root, mode) → [Hz, …]  — the seven diatonic-mode degrees from root,
// equal temperament (same math as note()). root is a note name or Hz number
// (anything note() accepts); mode defaults to 'major'.
// ---------------------------------------------------------------------------
const MODE_INTERVALS = {
  ionian:     [0, 2, 4, 5, 7, 9, 11],
  dorian:     [0, 2, 3, 5, 7, 9, 10],
  phrygian:   [0, 1, 3, 5, 7, 8, 10],
  lydian:     [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  aeolian:    [0, 2, 3, 5, 7, 8, 10],
  locrian:    [0, 1, 3, 5, 6, 8, 10],
};
const MODE_ALIAS = { major: 'ionian', minor: 'aeolian' };

export function scale(root, mode = 'major') {
  const name = MODE_ALIAS[mode] ?? mode;
  const intervals = MODE_INTERVALS[name];
  if (!intervals) throw new Error(`synthkit: unknown mode "${mode}"`);
  const base = note(root);
  return intervals.map((semitones) => base * Math.pow(2, semitones / 12));
}

// ---------------------------------------------------------------------------
// chord(root, quality) → [Hz, …]  — stacked-third chord tones from root, equal
// temperament (same math as scale()/note()). root is a note name or Hz number
// (anything note() accepts); quality defaults to 'major'.
// ---------------------------------------------------------------------------
const CHORD_INTERVALS = {
  major:           [0, 4, 7],
  minor:           [0, 3, 7],
  diminished:      [0, 3, 6],
  augmented:       [0, 4, 8],
  major7:          [0, 4, 7, 11],
  minor7:          [0, 3, 7, 10],
  dominant7:       [0, 4, 7, 10],
  diminished7:     [0, 3, 6, 9],
  halfDiminished7: [0, 3, 6, 10],
};
const CHORD_ALIAS = {
  maj: 'major', min: 'minor', m: 'minor', dim: 'diminished', aug: 'augmented',
  maj7: 'major7', min7: 'minor7', m7: 'minor7',
  dom7: 'dominant7', '7': 'dominant7', dim7: 'diminished7', m7b5: 'halfDiminished7',
};

export function chord(root, quality = 'major') {
  const name = CHORD_ALIAS[quality] ?? quality;
  const intervals = CHORD_INTERVALS[name];
  if (!intervals) throw new Error(`synthkit: unknown chord quality "${quality}"`);
  const base = note(root);
  return intervals.map((semitones) => base * Math.pow(2, semitones / 12));
}

// ---------------------------------------------------------------------------
// progression(root, roman) → [[Hz, …], …] — diatonic triads in a major
// key. Roman numerals carry the conventional major-key triad quality; the
// existing scale() and chord() helpers remain the single source of pitch math.
// ---------------------------------------------------------------------------
const MAJOR_ROMAN_TRIADS = {
  I:    [0, 'major'],
  ii:   [1, 'minor'],
  iii:  [2, 'minor'],
  IV:   [3, 'major'],
  V:    [4, 'major'],
  vi:   [5, 'minor'],
  'vii°': [6, 'diminished'],
};

export function progression(root, roman) {
  if (!Array.isArray(roman)) {
    throw new Error('synthkit: progression roman must be an array');
  }
  const degrees = scale(root, 'major');
  return roman.map((numeral) => {
    if (!Object.hasOwn(MAJOR_ROMAN_TRIADS, numeral)) {
      throw new Error(`synthkit: unknown roman numeral "${numeral}"`);
    }
    const triad = MAJOR_ROMAN_TRIADS[numeral];
    const [degree, quality] = triad;
    return chord(degrees[degree], quality);
  });
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

// Same coercion for the ADSR *time* fields (attack / decay / release, seconds).
// A malformed `release` is not just cosmetic: the buffer length is
// `sampleRate * (duration + release)`, so `release: NaN` silently produced a
// ZERO-length buffer, `release: -1` a 1-sample one (breaking the documented
// length contract of both render() and sequence()), and `release: 1e5` escaped
// the bound that sampleRate/duration already have and threw
// `RangeError: Invalid typed array length`. Non-numbers / NaN / Infinity fall
// back to the documented default; finite values are clamped to the same
// physically meaningful window as `duration`.
const ENV_TIME_MAX = 3600;
function envTime(x, def) {
  return finiteOpt(x, def, 0, ENV_TIME_MAX);
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
  const a = envTime(env.attack, 0.01);
  const d = envTime(env.decay, 0.05);
  const s = clamp01(env.sustain ?? 0.7); // sustain LEVEL (0..1), not a time
  const r = envTime(env.release, 0.1);

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
  return duration + envTime(env.release, 0.1);
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
// sequence(spec, opts) → Float32Array  [M2 slice 1, PURE / OFFLINE]
//
// Render a list of notes over time: every step is one render() call whose
// buffer is summed into the output at the step's start, so release tails
// overlap the next step exactly like a monophonic-per-step synth with a
// polyphonic tail. Same spec as render() (osc / env / gain / seed) plus:
//
// spec.seq: [ 'C4', 'E4', null, 440, … ]   note name | Hz | null/undefined = rest
// opts: {
//   sampleRate = 44100,
//   step = 0.25,   seconds per step (finite, 0..3600)
//   gate = 1,      fraction of the step the note is HELD (0..1); the rest of
//                  the step is the release tail (+ silence), i.e. staccato < 1
// }
//
// Output length = round(sampleRate * (seq.length * step + release)): the musical
// length of the pattern plus the last note's release tail, independent of gate.
//
// Overlapping tails are SUMMED. To keep the [-1, 1] invariant WITHOUT clipping
// distortion, every voice is scaled by 1 / (max simultaneous voices), where the
// voice count comes from how far a note's hold + release spills into later
// steps (polyphony headroom). If hold + release <= step (e.g. staccato gate or
// a short release) nothing overlaps and the level equals render()'s. A final
// clamp is only a safety net for sub-sample rounding at tail edges.
// ---------------------------------------------------------------------------
export function sequence(spec = {}, opts = {}) {
  const sampleRate = finiteOpt(opts.sampleRate, 44100, 1, 192000);
  const step = finiteOpt(opts.step, 0.25, 0, 3600);
  const gate = finiteOpt(opts.gate, 1, 0, 1);
  const seq = Array.isArray(spec.seq) ? spec.seq : [];
  const env = spec.env ?? {};
  const hold = step * gate;

  const release = envTime(env.release, 0.1);

  const totalSec = seq.length * step + release;
  const n = Math.max(1, Math.round(sampleRate * totalSec));
  const out = new Float32Array(n);

  // Polyphony headroom: how many LATER steps does one note (hold + release
  // tail) still sound into? That many extra voices can stack on top of a step's
  // own note, so scale each voice by 1 / (1 + extra) and the sum stays <= 1.
  const spill = hold + release - step;
  let extra = 0;
  if (spill > 0) extra = step > 0 ? Math.ceil(spill / step) : seq.length - 1;
  extra = Math.max(0, Math.min(seq.length - 1, extra));
  const headroom = 1 / (1 + extra);

  for (let i = 0; i < seq.length; i++) {
    const freq = seq[i];
    if (freq === null || freq === undefined) continue;        // rest: nothing to add
    const voice = render({ ...spec, freq }, { sampleRate, duration: hold });
    // Start AND end are rounded from absolute time, so a voice occupies exactly
    // [round(t0*sr), round(t1*sr)). Rounding the voice length instead could make
    // two back-to-back notes (release 0, gate 1) share one boundary sample at
    // full level — the sum would then exceed the headroom bound.
    const at = Math.round(i * step * sampleRate);
    const end = Math.min(n, Math.round((i * step + hold + release) * sampleRate), at + voice.length);
    for (let j = at; j < end; j++) out[j] += voice[j - at] * headroom;
  }
  for (let i = 0; i < n; i++) out[i] = clampSym(out[i], 1); // safety net only
  return out;
}

// ---------------------------------------------------------------------------
// TODO (M2) — music helpers (sequence() + scale() + chord() + progression()
// above are done so far):
//   sequence(): per-step velocity, PolyBLEP band-limiting for saw/square
// TODO (M2) — filters: lowpass(buf, cutoff, sr) / highpass(...) (one-pole/biquad)
// TODO (M3) — SFX presets: clack / riichi / tsumo / ron / doraFlip (intensity, pitch)
// TODO (M4) — live Web Audio:
//   export function connect(spec, audioContext) → { output: AudioNode, start, stop }
//   (build OscillatorNode → GainNode(ADSR via setValueAtTime) → BiquadFilter →
//    destination; same spec as render(), so offline tests guard the live path.)
// ---------------------------------------------------------------------------
