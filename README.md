# synthkit

**Pure, deterministic, headless-testable procedural audio / music / SFX
engine.** You describe sound as **plain data** (a *synth spec*) and the *same*
spec renders **offline to a `Float32Array`** (pure JS, no audio hardware — so
it can be FFT/RMS-checked in CI). A future Web Audio backend is planned for the
browser. Zero runtime dependencies, single-file ESM, no `Math.random` (seeded),
MIT. Built to drop into a game — augment Web-Audio SFX and drive dynamic BGM
from game state — but engine-agnostic. See [`DESIGN.md`](./DESIGN.md).

> **Status: M1 + first M2 slice.** Oscillators (`sine` / `saw` / `square` /
> `triangle` / `noise`) → ADSR envelope → offline `render`, `note(name)` → Hz,
> and `sequence()` — a list of notes / rests rendered over time. Filters,
> music-theory helpers and live `connect()` are planned for M2–M4. Every
> render is a clean, non-clipping, frequency-correct buffer that the test
> suite verifies by analyzing the samples (per-step pitch via windowed DFT).

## API

```js
render(spec, { sampleRate = 44100, duration = 0.3 }) → Float32Array   // current: offline, pure
sequence(spec, { sampleRate = 44100, step = 0.25, gate = 1 }) → Float32Array // current: notes over time
note(name) → Hz                                                 // current: 'A4' → 440
connect(spec, audioContext) → { output, start, stop }           // planned: live Web Audio [M4]
scale(root, mode) / chord(root, quality) / filters              // planned [M2]
```

A **spec** is plain data:

```js
{
  osc:  'sine',           // 'sine' | 'saw' | 'square' | 'triangle' | 'noise'
  freq: 'A4',             // note name OR a number in Hz
  env:  { attack: 0.01, decay: 0.05, sustain: 0.7, release: 0.1 },  // seconds; sustain is a LEVEL 0..1
  gain: 0.9,
  seed: 1                 // only the 'noise' osc uses it (deterministic)
}
```

`sustain` and `gain` values outside `0..1` are clamped to that range.

## Usage

### Offline render (Node — headless, testable)

```js
import { render, note } from 'synthkit';

// 0.3s A4 sine through an ADSR. Output length = sampleRate * (0.3 + release).
const buf = render(
  { osc: 'sine', freq: 'A4', env: { attack: 0.01, decay: 0.05, sustain: 0.7, release: 0.1 } },
  { sampleRate: 44100, duration: 0.3 }
);
// buf is a Float32Array of mono samples in [-1, 1] — write to WAV, analyze, etc.

note('A4'); // 440
note('A5'); // 880
```

### Sequence (notes over time — offline, pure)

```js
import { sequence } from 'synthkit';

// Four 0.25 s steps: C4, E4, rest, G4 — same spec fields as render() plus `seq`.
const buf = sequence(
  { osc: 'saw', env: { attack: 0.005, decay: 0.05, sustain: 0.6, release: 0.1 }, seq: ['C4', 'E4', null, 'G4'] },
  { sampleRate: 44100, step: 0.25, gate: 0.8 }
);
// Length = sampleRate * (seq.length * step + release). Each step is one render();
// release tails overlap the next step and are summed with polyphony headroom
// (each voice scaled by 1 / max simultaneous voices) so the output never clips.
```

`seq` entries are note names, raw Hz numbers, or `null` / `undefined` for a
rest. `gate` (0..1) is the fraction of each step the note is held; the rest of
the step is release tail / silence.

### Web Audio (browser) — *planned for M4*

```js
import { connect } from 'synthkit';

const ctx = new AudioContext();
const voice = connect({ osc: 'saw', freq: 'C4', env: { /* … */ } }, ctx);
voice.output.connect(ctx.destination);
voice.start();
```

## Test

```bash
node test.mjs      # or: npm test
# → synthkit M1: 76 passed
```

The test renders an A4 sine and asserts the buffer's length, finiteness, peak
(no clipping), RMS, determinism across two renders, the `note()` math, and —
via a small Goertzel DFT — that **440 Hz dominates the spectrum**. For
`sequence()` the same DFT probe is applied to a window in the middle of every
step to confirm the per-step pitch, plus rest silence, headroom and length.
That spectral check is how "did it make the right note?" becomes a headless
unit test.

## License

MIT © 2026 opaopa6969
