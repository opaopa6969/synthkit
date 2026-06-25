# synthkit

**Pure, deterministic, headless-testable procedural audio / music / SFX
engine.** You describe sound as **plain data** (a *synth spec*) and the *same*
spec renders **offline to a `Float32Array`** (pure JS, no audio hardware — so
it can be FFT/RMS-checked in CI) or connects **live to Web Audio** in the
browser. Zero runtime dependencies, single-file ESM, no `Math.random` (seeded),
MIT. Built to drop into a game — augment Web-Audio SFX and drive dynamic BGM
from game state — but engine-agnostic. See [`DESIGN.md`](./DESIGN.md).

> **Status: M1.** Oscillators (`sine` / `saw` / `square` / `triangle` /
> `noise`) → ADSR envelope → offline `render`, plus `note(name)` → Hz.
> Sequencer, filters, music-theory helpers and live `connect()` are M2–M4
> (stubbed / documented). M1 produces a clean, non-clipping, frequency-correct
> note that the test suite verifies by analyzing the rendered buffer.

## API

```js
render(spec, { sampleRate = 44100, duration }) → Float32Array   // (a) offline, pure
note(name) → Hz                                                 // 'A4' → 440 (eq. temperament)
connect(spec, audioContext) → { output, start, stop }           // (b) live Web Audio   [M4]
scale(root, mode) / chord(root, quality) / sequence(spec, opts) //                      [M2]
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

### Web Audio (browser) — *M4*

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
# → synthkit M1: 17 passed
```

The test renders an A4 sine and asserts the buffer's length, finiteness, peak
(no clipping), RMS, determinism across two renders, the `note()` math, and —
via a small Goertzel DFT — that **440 Hz dominates the spectrum**. That spectral
check is how "did it make the right note?" becomes a headless unit test.

## License

MIT © 2026 opaopa6969
