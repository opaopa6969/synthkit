// synthkit unit tests — proves the engine runs headless (no AudioContext / no
// audio hardware), is deterministic, and renders a clean, non-clipping note.
// Headless QA for audio = ANALYZING the buffer (length / peak / RMS / spectrum)
// since we cannot "listen". Run:  node test.mjs   (or: npm test)
import { render, note } from './index.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error('  ✗ ' + msg); } };

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

if (fail) { console.error(`synthkit M1: ${fail} FAILED, ${pass} passed`); process.exit(1); }
console.log(`synthkit M1: ${pass} passed`);
