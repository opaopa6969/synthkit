// synthkit unit tests — proves the engine runs headless (no AudioContext / no
// audio hardware), is deterministic, and renders a clean, non-clipping note.
// Headless QA for audio = ANALYZING the buffer (length / peak / RMS / spectrum)
// since we cannot "listen". Run:  node test.mjs   (or: npm test)
import { render, note, sequence, scale, chord, progression } from './index.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error('  ✗ ' + msg); } };
const throws = (fn, pattern, msg) => {
  try {
    fn();
  } catch (err) {
    ok(err instanceof Error && pattern.test(err.message), msg);
    return;
  }
  ok(false, msg);
};

const SR = 44100;
const DUR = 0.3;                          // held seconds
const spec = { osc: 'sine', freq: 'A4', env: { attack: 0.01, decay: 0.05, sustain: 0.7, release: 0.1 } };
const buf = render(spec, { sampleRate: SR, duration: DUR });

// peak / RMS analysis (our stand-in for "listening")
let peak = 0, sumSq = 0, allFinite = true;
for (let i = 0; i < buf.length; i++) {
  const v = buf[i];
  if (!Number.isFinite(v)) allFinite = false;
  const a = Math.abs(v);
  if (a > peak) peak = a;
  sumSq += v * v;
}

const rms = Math.sqrt(sumSq / buf.length);

// (a) length == sampleRate * (held duration + release tail)
const expectedLen = Math.round(SR * (DUR + 0.1));
ok(buf.length === expectedLen, `length is sampleRate*(duration+release) (got ${buf.length}, want ${expectedLen})`);

// (b) every sample finite and NO clipping (|sample| <= 1)
ok(allFinite, 'all samples are finite');
ok(peak <= 1, `no clipping — peak |sample| <= 1 (got ${peak.toFixed(4)})`);

// (c) signal is non-trivial — there IS sound, and it is not maxed out
ok(rms > 0.05 && rms < 0.8, `RMS in a sane range (got ${rms.toFixed(4)})`);
ok(peak > 0.3, `peak is audibly large (got ${peak.toFixed(4)})`);

// (d) note() — equal temperament, A4 = 440, A5 = 880, octave doubling
ok(Math.abs(note('A4') - 440) < 1e-9, `note('A4') ≈ 440 (got ${note('A4')})`);
ok(Math.abs(note('A5') - 880) < 1e-9, `note('A5') ≈ 880 (got ${note('A5')})`);
ok(Math.abs(note('A4') * 2 - note('A5')) < 1e-9, 'one octave doubles the frequency');
// a couple of well-known reference pitches
ok(Math.abs(note('C4') - 261.6256) < 1e-3, `note('C4') ≈ 261.63 (got ${note('C4').toFixed(4)})`);
ok(Math.abs(note('E4') - 329.6276) < 1e-3, `note('E4') ≈ 329.63 (got ${note('E4').toFixed(4)})`);
ok(Math.abs(note('A#4') - note('Bb4')) < 1e-9, 'A#4 and Bb4 are enharmonic-equal');
ok(note(123.45) === 123.45, 'note() passes numeric frequencies through unchanged');
ok(Math.abs(note('C-1') * 2 - note('C0')) < 1e-9, 'note() accepts negative octaves');
throws(() => note('H4'), /bad note name "H4"/, 'note() rejects invalid note names');
throws(() => render({ osc: 'supersaw' }), /unknown osc type "supersaw"/, 'render() rejects unknown oscillator types');

// scale(root, mode) — the 7 diatonic-mode degrees from root, equal
// temperament. Checked against note() directly rather than hard-coded Hz
// values so the assertion tracks note()'s own math.
{
  const degrees = (root, names) => names.map((n) => note(n));

  const cMajor = scale('C4', 'major');
  const cMajorExpected = degrees('C4', ['C4', 'D4', 'E4', 'F4', 'G4', 'A4', 'B4']);
  ok(cMajor.length === 7, `scale() returns 7 degrees (got ${cMajor.length})`);
  ok(cMajor.every((hz, i) => Math.abs(hz - cMajorExpected[i]) < 1e-9),
    `scale('C4', 'major') matches C D E F G A B (got ${cMajor.map((h) => h.toFixed(2))})`);

  const aMinor = scale('A4', 'minor');
  const aMinorExpected = degrees('A4', ['A4', 'B4', 'C5', 'D5', 'E5', 'F5', 'G5']);
  ok(aMinor.every((hz, i) => Math.abs(hz - aMinorExpected[i]) < 1e-9),
    `scale('A4', 'minor') matches A B C D E F G, one octave up where it wraps (got ${aMinor.map((h) => h.toFixed(2))})`);

  // 'major'/'minor' are aliases for 'ionian'/'aeolian'.
  ok(scale('C4', 'ionian').every((hz, i) => hz === cMajor[i]), "mode 'ionian' is an alias for 'major'");
  ok(scale('A4', 'aeolian').every((hz, i) => hz === aMinor[i]), "mode 'aeolian' is an alias for 'minor'");

  // the other five diatonic modes are reachable and each degree is a valid,
  // finite, positive frequency (full correctness of every mode's interval
  // table would just re-state MODE_INTERVALS; this proves they resolve).
  for (const mode of ['dorian', 'phrygian', 'lydian', 'mixolydian', 'locrian']) {
    const degs = scale('C4', mode);
    ok(degs.length === 7 && degs.every((hz) => Number.isFinite(hz) && hz > 0),
      `scale('C4', '${mode}') returns 7 finite, positive frequencies`);
  }

  // default mode is 'major'.
  ok(scale('C4').every((hz, i) => hz === cMajor[i]), "scale() with no mode defaults to 'major'");

  // root accepts a raw Hz number too, same as spec.freq / render().
  ok(scale(440, 'major')[0] === 440, 'scale() accepts a numeric Hz root');

  throws(() => scale('C4', 'blues'), /unknown mode "blues"/, 'scale() rejects unknown modes');

  // scale() output drops straight into sequence()'s seq (a scale run).
  const run = sequence({ osc: 'sine', env: { attack: 0, decay: 0, sustain: 1, release: 0 }, seq: scale('C4', 'major') },
    { sampleRate: 10, step: 1 });
  ok(run.length === 70 && run.every((v) => Number.isFinite(v) && Math.abs(v) <= 1),
    `scale('C4', 'major') feeds sequence()'s seq without producing NaN or clipping (got ${run.length} samples)`);
}

// chord(root, quality) — stacked chord tones from root, equal temperament.
// Checked against note() directly, same style as the scale() tests above.
{
  const degrees = (root, names) => names.map((n) => note(n));

  const cMajor = chord('C4', 'major');
  const cMajorExpected = degrees('C4', ['C4', 'E4', 'G4']);
  ok(cMajor.length === 3, `chord() triad returns 3 tones (got ${cMajor.length})`);
  ok(cMajor.every((hz, i) => Math.abs(hz - cMajorExpected[i]) < 1e-9),
    `chord('C4', 'major') matches C E G (got ${cMajor.map((h) => h.toFixed(2))})`);

  const cMinor = chord('C4', 'minor');
  const cMinorExpected = degrees('C4', ['C4', 'Eb4', 'G4']);
  ok(cMinor.every((hz, i) => Math.abs(hz - cMinorExpected[i]) < 1e-9),
    `chord('C4', 'minor') matches C Eb G (got ${cMinor.map((h) => h.toFixed(2))})`);

  const cDom7 = chord('C4', 'dominant7');
  const cDom7Expected = degrees('C4', ['C4', 'E4', 'G4', 'Bb4']);
  ok(cDom7.length === 4 && cDom7.every((hz, i) => Math.abs(hz - cDom7Expected[i]) < 1e-9),
    `chord('C4', 'dominant7') matches C E G Bb (got ${cDom7.map((h) => h.toFixed(2))})`);

  // short aliases resolve to the same tones as their full quality name.
  ok(chord('C4', 'maj').every((hz, i) => hz === cMajor[i]), "quality 'maj' is an alias for 'major'");
  ok(chord('C4', 'min').every((hz, i) => hz === cMinor[i]), "quality 'min' is an alias for 'minor'");
  ok(chord('C4', 'm').every((hz, i) => hz === cMinor[i]), "quality 'm' is an alias for 'minor'");
  ok(chord('C4', '7').every((hz, i) => hz === cDom7[i]), "quality '7' is an alias for 'dominant7'");

  // the remaining qualities are reachable and each tone is a valid, finite,
  // positive frequency (full correctness of every interval set would just
  // re-state CHORD_INTERVALS; this proves they resolve).
  for (const quality of ['diminished', 'augmented', 'major7', 'minor7', 'diminished7', 'halfDiminished7']) {
    const tones = chord('C4', quality);
    ok(tones.length >= 3 && tones.every((hz) => Number.isFinite(hz) && hz > 0),
      `chord('C4', '${quality}') returns finite, positive frequencies`);
  }

  // default quality is 'major'.
  ok(chord('C4').every((hz, i) => hz === cMajor[i]), "chord() with no quality defaults to 'major'");

  // root accepts a raw Hz number too, same as scale()/spec.freq.
  ok(chord(440, 'major')[0] === 440, 'chord() accepts a numeric Hz root');

  throws(() => chord('C4', 'blues'), /unknown chord quality "blues"/, 'chord() rejects unknown qualities');

  // chord() output drops straight into sequence()'s seq (a block-chord arp).
  const run = sequence({ osc: 'sine', env: { attack: 0, decay: 0, sustain: 1, release: 0 }, seq: chord('C4', 'major') },
    { sampleRate: 10, step: 1 });
  ok(run.length === 30 && run.every((v) => Number.isFinite(v) && Math.abs(v) <= 1),
    `chord('C4', 'major') feeds sequence()'s seq without producing NaN or clipping (got ${run.length} samples)`);
}

// progression(root, roman) — major-key diatonic triads composed from scale()
// and chord(). The result preserves progression boundaries as nested chords.
{
  const pop = progression('C4', ['I', 'vi', 'IV', 'V']);
  const expected = [
    chord('C4', 'major'),
    chord('A4', 'minor'),
    chord('F4', 'major'),
    chord('G4', 'major'),
  ];
  ok(pop.length === 4 && pop.every((tones, i) =>
    tones.length === expected[i].length && tones.every((hz, j) => Math.abs(hz - expected[i][j]) < 1e-9)),
  "progression('C4', ['I','vi','IV','V']) returns C-Am-F-G triads in input order");

  const all = progression('C4', ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°']);
  ok(all.length === 7 && all.every((tones) =>
    tones.length === 3 && tones.every((hz) => Number.isFinite(hz) && hz > 0)),
  'progression() resolves all seven major-key diatonic triads');
  ok(all[6].every((hz, i) => Math.abs(hz - chord('B4', 'diminished')[i]) < 1e-9),
    'progression() resolves vii° as the diminished leading-tone triad');

  ok(progression(440, ['I'])[0][0] === 440, 'progression() accepts a numeric Hz root');
  ok(progression('C4', []).length === 0, 'progression() accepts an empty progression');
  throws(() => progression('C4', 'I-IV-V'), /progression roman must be an array/,
    'progression() requires an array of Roman numerals');
  throws(() => progression('C4', ['bVII']), /unknown roman numeral "bVII"/,
    'progression() rejects unsupported Roman numerals');
  throws(() => progression('C4', ['toString']), /unknown roman numeral "toString"/,
    'progression() does not accept inherited object-property names as numerals');

  // Flattening the chord boundaries gives sequence() a deterministic arpeggio.
  const arp = sequence({ osc: 'sine', env: { attack: 0, decay: 0, sustain: 1, release: 0 }, seq: pop.flat() },
    { sampleRate: 10, step: 1 });
  ok(arp.length === 120 && arp.every((v) => Number.isFinite(v) && Math.abs(v) <= 1),
    'progression().flat() feeds sequence() without producing NaN or clipping');
}

// Zero-length ADSR stages transition immediately and remain finite.
{
  const zeroEnv = render({
    osc: 'square', freq: 0, gain: 1,
    env: { attack: 0, decay: 0, sustain: 0.5, release: 0 }
  }, { sampleRate: 10, duration: 0.3 });
  ok(zeroEnv.length === 3, `zero-release ADSR has no tail (got ${zeroEnv.length} samples)`);
  ok(zeroEnv.every((v) => Number.isFinite(v) && v === 0.5), 'zero-length ADSR stages render the sustain level');
}

// Releasing a note during the ATTACK phase must not jump. The envelope continues
// the attack ramp up to note-off, then releases from that held value (not from
// the sustain level) — so the amplitude is continuous across the release
// boundary. Regression guard for the click/pop described in issue #10.
{
  const buf = render({
    osc: 'square', freq: 0, gain: 1,
    env: { attack: 0.1, decay: 0, sustain: 0, release: 0.1 }
  }, { sampleRate: 44100, duration: 0.05 });
  // Note-off at t=0.05 (mid-attack); release ramp starts there from amp ≈ 0.5.
  const iOff = Math.round(0.05 * 44100);
  const ampAtOff = buf[iOff];
  ok(Math.abs(ampAtOff - 0.5) < 1e-3, `release starts from the attack value at note-off (got ${ampAtOff.toFixed(4)}, want ≈0.5)`);
  // No discontinuity anywhere in the buffer (max sample-to-sample step is tiny).
  let maxStep = 0;
  for (let i = 1; i < buf.length; i++) maxStep = Math.max(maxStep, Math.abs(buf[i] - buf[i - 1]));
  ok(maxStep < 1e-3, `no release-boundary discontinuity (max |Δsample| = ${maxStep.toExponential(3)})`);
  ok(buf.every(Number.isFinite), 'released-during-attack buffer stays finite');
}

// Level inputs are saturated to their documented 0..1 range so invalid specs
// cannot produce a clipping buffer or invert the signal.
{
  const sample = (gain, sustain) => render({
    osc: 'square', freq: 0, gain,
    env: { attack: 0, decay: 0, sustain, release: 0 }
  }, { sampleRate: 10, duration: 0.1 })[0];
  ok(sample(1.5, 1) === 1, 'gain above 1 is clamped to 1');
  ok(sample(1, 1.5) === 1, 'sustain above 1 is clamped to 1');
  ok(sample(-0.5, 1) === 0, 'gain below 0 is clamped to 0');
  ok(sample(1, -0.5) === 0, 'sustain below 0 is clamped to 0');
  ok(Number.isNaN(sample(NaN, 1)), 'gain NaN is propagated by canonical clamp01');
  ok(Number.isNaN(sample(1, NaN)), 'sustain NaN is propagated by canonical clamp01');
  ok(sample(Infinity, 1) === 1, 'gain Infinity is clamped to 1');
  ok(sample(-Infinity, 1) === 0, 'gain -Infinity is clamped to 0');
}
{
  // Canonical clamp01 deliberately propagates NaN through the rendered buffer.
  const finiteBuf = (gain, sustain) => render({
    osc: 'square', freq: 0, gain,
    env: { attack: 0, decay: 0, sustain, release: 0 }
  }, { sampleRate: 10, duration: 0.1 }).every(Number.isFinite);
  ok(!finiteBuf(NaN, 1), 'gain NaN propagates through the buffer');
  ok(!finiteBuf(1, NaN), 'sustain NaN propagates through the buffer');
}

// (e) DETERMINISTIC — two renders of the same spec are byte-identical
{
  const a = render(spec, { sampleRate: SR, duration: DUR });
  const b = render(spec, { sampleRate: SR, duration: DUR });
  let same = a.length === b.length;
  for (let i = 0; i < a.length && same; i++) if (a[i] !== b[i]) same = false;
  ok(same, 'render is deterministic across two runs (no Math.random)');
}
// …including the noise oscillator, which is seeded
{
  const ns = { osc: 'noise', seed: 7, env: { attack: 0.001, decay: 0.01, sustain: 1, release: 0.01 } };
  const a = render(ns, { sampleRate: SR, duration: 0.05 });
  const b = render(ns, { sampleRate: SR, duration: 0.05 });
  let same = a.length === b.length;
  for (let i = 0; i < a.length && same; i++) if (a[i] !== b[i]) same = false;
  ok(same, 'seeded noise is deterministic across two runs');
}
// Different seeds produce different deterministic noise sequences.
{
  const noise = (seed) => render({
    osc: 'noise', seed, gain: 1,
    env: { attack: 0, decay: 0, sustain: 1, release: 0 }
  }, { sampleRate: SR, duration: 0.01 });
  const a = noise(7);
  const b = noise(8);
  let same = a.length === b.length;
  for (let i = 0; i < a.length && same; i++) if (a[i] !== b[i]) same = false;
  ok(!same, 'different seeds produce different noise output');
}

// Seeded noise remains broadband: sampled low/mid/high DFT bands should have
// comparable energy rather than collapsing into a narrow spectral band.
{
  const N = 4096;
  const noise = render({
    osc: 'noise', seed: 7, gain: 1,
    env: { attack: 0, decay: 0, sustain: 1, release: 0 }
  }, { sampleRate: SR, duration: N / SR });
  const powerAtBin = (k) => {
    const omega = (2 * Math.PI * k) / N;
    const cw = Math.cos(omega), coeff = 2 * cw;
    let s0 = 0, s1 = 0, s2 = 0;
    for (let i = 0; i < N; i++) {
      s0 = noise[i] + coeff * s1 - s2;
      s2 = s1; s1 = s0;
    }
    const real = s1 - s2 * cw;
    const imag = s2 * Math.sin(omega);
    return real * real + imag * imag;
  };
  const bandPower = (firstBin) => {
    let power = 0;
    for (let k = firstBin; k < firstBin + 16; k++) power += powerAtBin(k);
    return power;
  };
  const bands = [bandPower(8), bandPower(160), bandPower(800)];
  const spectralRatio = Math.max(...bands) / Math.min(...bands);
  ok(spectralRatio < 3, `noise has broadband low/mid/high energy (ratio ${spectralRatio.toFixed(3)})`);
}

// (f) SPECTRUM — a tiny DFT confirms 440 Hz dominates a window of the A4 sine.
// We probe a 4096-sample window taken during the sustain phase and compare the
// magnitude at the 440 Hz bin against neighbours.
{
  const N = 4096;
  const start = Math.round(SR * (DUR * 0.5));     // mid-sustain, away from edges
  // Goertzel magnitude at frequency f over buf[start .. start+N]
  const mag = (f) => {
    const k = (f * N) / SR;
    const omega = (2 * Math.PI * k) / N;
    const cw = Math.cos(omega), coeff = 2 * cw;
    let s0 = 0, s1 = 0, s2 = 0;
    for (let i = 0; i < N; i++) {
      s0 = buf[start + i] + coeff * s1 - s2;
      s2 = s1; s1 = s0;
    }
    const real = s1 - s2 * cw;
    const imag = s2 * Math.sin(omega);
    return Math.hypot(real, imag);
  };
  const m440 = mag(440);
  const m220 = mag(220);
  const m880 = mag(880);
  const m660 = mag(660);
  ok(m440 > m220 * 3 && m440 > m880 * 3 && m440 > m660 * 3,
    `440 Hz dominates the spectrum (440=${m440.toFixed(1)} vs 220=${m220.toFixed(1)}, 660=${m660.toFixed(1)}, 880=${m880.toFixed(1)})`);
}

// other oscillator shapes also render clean, non-clipping buffers
for (const osc of ['saw', 'square', 'triangle']) {
  const b = render({ osc, freq: 'C4', env: { attack: 0.005, decay: 0.02, sustain: 0.8, release: 0.05 } }, { sampleRate: SR, duration: 0.1 });
  let p = 0, fin = true;
  for (let i = 0; i < b.length; i++) { if (!Number.isFinite(b[i])) fin = false; const a = Math.abs(b[i]); if (a > p) p = a; }
  ok(fin && p <= 1 && p > 0.3, `${osc} renders finite, non-clipping, audible (peak ${p.toFixed(3)})`);
}

// Phase wrap must cover freq >= sampleRate. The old `phase -= 1` only subtracted
// once, so for dPhase >= 2 (freq >= 2*sampleRate) the phase stayed >= 1 and the
// square oscillator collapsed to a constant -1. Regression guard for issue #11.
{
  // dPhase = 1.5: phase visits 0 → 1.5 → 0.5 → 2.0 → 0.0 … so square alternates
  // 1, -1, 1, -1 (not the pre-fix collapse to 1, -1, -1, -1).
  const b = render({
    osc: 'square', freq: 1.5 * 10, gain: 1,
    env: { attack: 0, decay: 0, sustain: 1, release: 0 }
  }, { sampleRate: 10, duration: 0.4 });
  const seq = Array.from(b).map((v) => (v > 0 ? '+' : '-'));
  ok(seq.join('') === '+-+-', `square at freq=1.5*sampleRate alternates (got ${seq.join('')})`);

  // dPhase = 2: phase wraps to 0 every sample → square stays at the phase-0
  // value (+1), instead of collapsing to -1.
  const c = render({
    osc: 'square', freq: 2 * 10, gain: 1,
    env: { attack: 0, decay: 0, sustain: 1, release: 0 }
  }, { sampleRate: 10, duration: 0.4 });
  ok(c.every((v) => v === 1), 'square at freq=2*sampleRate does not collapse to -1');

  // All oscillators stay finite and in [-1,1] at extreme freq.
  for (const osc of ['sine', 'saw', 'square', 'triangle']) {
    const d = render({
      osc, freq: 10 * 10, gain: 1,
      env: { attack: 0, decay: 0, sustain: 1, release: 0 }
    }, { sampleRate: 10, duration: 0.4 });
    ok(d.every((v) => Number.isFinite(v) && Math.abs(v) <= 1), `${osc} at freq=10*sampleRate stays finite and in [-1,1]`);
  }
}

// render() bounds sampleRate / duration so a malformed spec cannot drive an
// unbounded buffer allocation. The buffer length is sampleRate*(duration+
// release); without bounds, `sampleRate: 1e9, duration: 1` would allocate ~4.4
// GB and spin the render loop until the host is killed. Hostile / non-finite
// values normalise to the defaults (44100 Hz / 0.3 s); finite out-of-range
// values clamp to the physically meaningful window [1..192000] Hz / [0..3600] s.
{
  // Repro of the original DoS: now completes instantly instead of allocating GB.
  const b = render({ osc: 'sine' }, { sampleRate: 1e9, duration: 1 });
  // sampleRate clamps to 192000; duration (1 s) is in range → length == 192000 * (1 + 0.1 release).
  ok(b.length === Math.round(192000 * 1.1), `huge sampleRate clamped to 192000 (got ${b.length})`);
  ok(b.every(Number.isFinite), 'clamped-sampleRate buffer is all finite');

  // Non-finite sampleRate falls back to the 44100 default (no throw, no GB).
  for (const bad of [NaN, Infinity, -Infinity, 'bad', undefined, null]) {
    const c = render({ osc: 'sine', freq: 1 }, { sampleRate: bad, duration: 0.01 });
    ok(c.length === Math.round(44100 * (0.01 + 0.1)), `non-finite sampleRate ${String(bad)} → default 44100 (got ${c.length})`);
  }

  // Non-finite duration falls back to the 0.3 default.
  for (const bad of [NaN, Infinity, -Infinity]) {
    const c = render({ osc: 'sine', freq: 1 }, { sampleRate: 10, duration: bad });
    ok(c.length === Math.round(10 * (0.3 + 0.1)), `non-finite duration ${String(bad)} → default 0.3 (got ${c.length})`);
  }

  // Finite out-of-range duration clamps to [0, 3600] (not default, not unbounded).
  const big = render({ osc: 'sine', freq: 1 }, { sampleRate: 10, duration: 1e6 });
  ok(big.length === Math.round(10 * (3600 + 0.1)), `huge duration clamps to 3600 s (got ${big.length})`);

  // sampleRate floor is 1 (0 / negative clamp up, not down to an empty buffer).
  const floor = render({ osc: 'sine', freq: 1 }, { sampleRate: 0, duration: 0.1 });
  ok(floor.length === Math.max(1, Math.round(1 * (0.1 + 0.1))), `sampleRate 0 clamps to 1 (got ${floor.length})`);
}

// ---------------------------------------------------------------------------
// sequence() — M2 slice 1: a list of notes / rests rendered over time.
// ---------------------------------------------------------------------------
{
  // Goertzel magnitude of `f` over buf[start .. start+N] (windowed DFT probe).
  const magAt = (b, start, N, f) => {
    const k = (f * N) / SR;
    const omega = (2 * Math.PI * k) / N;
    const cw = Math.cos(omega), coeff = 2 * cw;
    let s0 = 0, s1 = 0, s2 = 0;
    for (let i = 0; i < N; i++) {
      s0 = b[start + i] + coeff * s1 - s2;
      s2 = s1; s1 = s0;
    }
    return Math.hypot(s1 - s2 * cw, s2 * Math.sin(omega));
  };
  const peakOf = (b, from = 0, to = b.length) => {
    let p = 0;
    for (let i = from; i < to; i++) p = Math.max(p, Math.abs(b[i]));
    return p;
  };
  const sameBuf = (a, b) => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  };

  const STEP = 0.25;
  const env = { attack: 0.01, decay: 0.05, sustain: 0.7, release: 0.1 };
  const seqSpec = { osc: 'sine', env, gain: 0.9, seq: ['C4', 'E4', null, 'G4'] };
  const buf = sequence(seqSpec, { sampleRate: SR, step: STEP });

  // length = sampleRate * (steps * step + release), regardless of rests.
  const wantLen = Math.round(SR * (4 * STEP + env.release));
  ok(buf.length === wantLen, `sequence length is sampleRate*(steps*step+release) (got ${buf.length}, want ${wantLen})`);
  ok(buf.every(Number.isFinite), 'sequence buffer is all finite');
  ok(peakOf(buf) <= 1, `sequence never clips (peak ${peakOf(buf).toFixed(4)})`);
  ok(peakOf(buf) > 0.3, `sequence is audibly loud (peak ${peakOf(buf).toFixed(4)})`);

  // per-step pitch: in the middle of each sounding step the expected note
  // dominates over the other two notes of the pattern.
  const N = 4096;
  const expect = [note('C4'), note('E4'), null, note('G4')];
  for (let i = 0; i < expect.length; i++) {
    if (expect[i] === null) continue;
    const start = Math.round(SR * (i * STEP + STEP * 0.5)) - N / 2;
    const mags = expect.map((f) => (f === null ? 0 : magAt(buf, start, N, f)));
    const others = mags.filter((_, j) => j !== i && expect[j] !== null);
    ok(others.every((m) => mags[i] > m * 3),
      `step ${i} is dominated by ${['C4', 'E4', '-', 'G4'][i]} (mags ${mags.map((m) => m.toFixed(1)).join('/')})`);
  }

  // the rest step is silent once the previous note's release tail has died out.
  const restFrom = Math.round(SR * (2 * STEP + env.release)) + 1;
  const restTo = Math.round(SR * (3 * STEP));
  ok(peakOf(buf, restFrom, restTo) === 0, `rest step is silent after the release tail (peak ${peakOf(buf, restFrom, restTo)})`);

  // deterministic across two runs.
  ok(sameBuf(buf, sequence(seqSpec, { sampleRate: SR, step: STEP })), 'sequence is deterministic across two runs');

  // headroom: with release 0.1 spilling into the next step, each voice is scaled
  // by 1/2 so two summed voices stay <= gain (0.9) and the safety clamp never
  // engages (no sample sits exactly at +-1).
  ok(peakOf(buf) <= 0.9, `overlapping tails are scaled for headroom, sum <= gain (peak ${peakOf(buf).toFixed(4)})`);
  ok(buf.every((v) => Math.abs(v) < 1), 'safety clamp does not engage for the default-style spec');
  // …and with NO spill (staccato gate) the level equals a plain render().
  const stacc = sequence({ osc: 'square', env: { attack: 0, decay: 0, sustain: 1, release: 0 }, gain: 1, seq: [1] },
    { sampleRate: 10, step: 1, gate: 0.5 });
  ok(stacc.length === 10, `gate < 1 keeps the pattern length (got ${stacc.length})`);
  ok(Array.from(stacc).map((v) => (v === 1 ? '+' : v === 0 ? '0' : '?')).join('') === '+++++00000',
    'gate 0.5 holds the note for half the step, then silence, at full level');

  // rests only / empty pattern → silent buffers of the right length, no throw.
  const rests = sequence({ seq: [null, undefined], env }, { sampleRate: 10, step: 0.5 });
  ok(rests.length === 11 && rests.every((v) => v === 0), 'rest-only pattern renders silence');
  const empty = sequence({ seq: [] , env: { release: 0 } }, { sampleRate: 10 });
  ok(empty.length === 1 && empty[0] === 0, 'empty pattern renders a single silent sample');
  ok(sequence({}, { sampleRate: 10 }).length === 1, 'missing seq behaves like an empty pattern');

  // Hz numbers are accepted per step, same as render()'s freq.
  const hz = sequence({ osc: 'sine', env, seq: [440] }, { sampleRate: SR, step: 0.3 });
  ok(magAt(hz, Math.round(SR * 0.15) - N / 2, N, 440) > magAt(hz, Math.round(SR * 0.15) - N / 2, N, 220) * 3,
    'numeric Hz steps render that frequency');

  // Back-to-back notes (release 0, gate 1) on a non-integer sample step must
  // neither overlap nor leave a gap: sr=10, step=0.25 → step edges land on
  // 2.5 / 5 / 7.5 samples. Rounding the voice LENGTH would put the 3rd note on
  // [5,8) and the 2nd on [3,6) — sample 5 summed to 2×. Rounding absolute
  // start/end instead tiles the pattern exactly.
  const tiled = sequence({ osc: 'square', env: { attack: 0, decay: 0, sustain: 1, release: 0 }, gain: 0.5, seq: [0, 0, 0, 0] },
    { sampleRate: 10, step: 0.25 });
  ok(tiled.length === 10 && tiled.every((v) => v === 0.5),
    `back-to-back notes tile without overlap or gap (got ${Array.from(tiled).join(',')})`);

  // step 0 (all notes at once) still honours the [-1,1] invariant.
  const stacked = sequence({ osc: 'square', env: { attack: 0, decay: 0, sustain: 1, release: 0.5 }, gain: 1, seq: [0, 0, 0] },
    { sampleRate: 10, step: 0 });
  ok(stacked.every((v) => Number.isFinite(v) && Math.abs(v) <= 1), 'step 0 stacks voices without exceeding [-1,1]');
  ok(stacked[0] === 1, `step 0 stacks 3 voices at 1/3 each (got ${stacked[0]})`);
}

// ---------------------------------------------------------------------------
// Malformed ADSR *time* fields must not break the documented length contract.
// The buffer length is sampleRate * (duration + release), so a bad `release`
// used to silently produce an empty (NaN) or 1-sample (negative) buffer, and a
// huge one escaped the sampleRate/duration bound with a RangeError.
// ---------------------------------------------------------------------------
{
  const sr = 1000, dur = 0.2;
  const lenOf = (release) => render({ osc: 'sine', freq: 'A4', env: { release } }, { sampleRate: sr, duration: dur }).length;
  const defaultLen = Math.round(sr * (dur + 0.1));

  ok(lenOf(NaN) === defaultLen, `release NaN falls back to the 0.1 s default (got ${lenOf(NaN)}, want ${defaultLen})`);
  ok(lenOf(Infinity) === defaultLen, `release Infinity falls back to the default (got ${lenOf(Infinity)})`);
  ok(lenOf('0.5') === defaultLen, `non-number release falls back to the default (got ${lenOf('0.5')})`);
  ok(lenOf(-1) === Math.round(sr * dur), `negative release clamps to 0, not to an empty buffer (got ${lenOf(-1)})`);
  ok(lenOf(1e5) === Math.round(sr * (dur + 3600)), `huge release clamps to 3600 s instead of throwing (got ${lenOf(1e5)})`);

  // A bad release must not poison the samples either.
  const nanRel = render({ osc: 'sine', freq: 'A4', env: { release: NaN } }, { sampleRate: sr, duration: dur });
  ok(nanRel.every((v) => Number.isFinite(v) && Math.abs(v) <= 1), 'release NaN still renders finite, non-clipping samples');

  // attack / decay take the same treatment: bad values fall back to defaults
  // (a NaN attack used to compare false and skip straight to sustain).
  const nanAtk = render({ osc: 'sine', freq: 'A4', env: { attack: NaN, decay: NaN } }, { sampleRate: sr, duration: dur });
  const goodAtk = render({ osc: 'sine', freq: 'A4', env: { attack: 0.01, decay: 0.05 } }, { sampleRate: sr, duration: dur });
  ok(nanAtk.length === goodAtk.length && nanAtk.every((v, i) => v === goodAtk[i]),
    'NaN attack / decay render exactly like the documented defaults');
  ok(render({ osc: 'sine', freq: 'A4', env: { attack: -1, decay: -1 } }, { sampleRate: sr, duration: dur })
    .every((v) => Number.isFinite(v)), 'negative attack / decay clamp to 0 and stay finite');

  // sequence() inherits the same contract: length = sr * (steps * step + release).
  const seqSpec = (release) => sequence({ osc: 'sine', env: { release }, seq: ['C4', 'E4'] }, { sampleRate: sr, step: 0.25 });
  ok(seqSpec(NaN).length === Math.round(sr * (2 * 0.25 + 0.1)),
    `sequence() release NaN keeps the documented length (got ${seqSpec(NaN).length})`);
  ok(seqSpec(-1).length === Math.round(sr * (2 * 0.25)),
    `sequence() negative release clamps to 0 (got ${seqSpec(-1).length})`);
  ok(seqSpec(NaN).every((v) => Number.isFinite(v) && Math.abs(v) <= 1), 'sequence() release NaN stays finite and unclipped');
}

if (fail) { console.error(`synthkit M1: ${fail} FAILED, ${pass} passed`); process.exit(1); }
console.log(`synthkit M1: ${pass} passed`);
