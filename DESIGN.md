# synthkit — design

A **procedural audio / music / SFX synthesis engine**. You describe sound as
**plain data** — a *synth spec* — and the engine turns that one spec into
either (the offline path is implemented in M1; the live path is planned for M4):

- **(a) an offline sample buffer** (`Float32Array`, mono, `[-1, 1]`),
  synthesized in pure JS with no audio hardware — fully **headless-testable**;
  or
- **(b) live Web Audio nodes** in a browser (`connect(spec, audioContext)`, M4).

The spec is engine-agnostic, but synthkit is designed to drop into a game: it
can both **augment an existing Web-Audio SFX layer** and drive **dynamic BGM**
from game state (tension, round, score).

## Why this shape

- **minimal primitives × combinatorial expressiveness** — a handful of
  primitives (oscillator, ADSR, filter, sequencer) COMBINE into notes, arps,
  chords, progressions and SFX. We don't ship a preset zoo; we ship the parts.
- **plain data, two backends** — the spec is just JSON-able data. The *same*
  spec renders offline (for tests / pre-baking / Node) and connects live (in
  the browser). The offline path is the source of truth the live path must
  match, so tests guard both.
- **deterministic (no `Math.random`)** — noise uses a seeded PRNG
  (mulberry32). Every render is byte-reproducible, so the output buffer can be
  asserted on in CI.
- **headless QA = analyzing the buffer** — we can't "listen" in CI. Instead we
  analyze the rendered `Float32Array`: length, peak (clipping), RMS (loudness /
  silence), finiteness, and a small DFT / Goertzel probe to confirm the
  **dominant frequency** and harmonic content. That is how "did it produce the
  right note?" becomes a unit test.

## House style (matches motion-engine / xpbd-body)

- **Pure ESM**, **zero runtime dependencies**, single-file `index.js`.
- **Deterministic**, **headless-testable in Node** (`node test.mjs`).
- **Renderer-agnostic**: `index.js` imports no DOM / AudioContext. The offline
  path is plain math; the live path (M4) takes an `audioContext` as a
  parameter rather than reaching for a global.
- MIT, author `opaopa6969`.

## Primitives

| Primitive    | What it is                                            | Milestone |
| ------------ | ----------------------------------------------------- | --------- |
| Oscillator   | `sine` / `saw` / `square` / `triangle` / `noise`      | M1        |
| Envelope     | ADSR — attack / decay / sustain (level) / release     | M1        |
| Filter       | low-pass / high-pass (one-pole → biquad)              | M2        |
| Sequencer    | notes/events over time (steps, durations, gate)       | M2        |
| Music theory | `scale(root, mode)`, `chord(root, quality)`, progressions | M2    |
| Mixer/graph  | a spec `{ osc, env, filter, seq, gain }` → output      | M2/M4     |

### The synth spec (M1 subset, live today)

```js
{
  osc:  'sine',                 // 'sine' | 'saw' | 'square' | 'triangle' | 'noise'
  freq: 'A4',                   // note name OR a number in Hz
  env:  { attack: 0.01, decay: 0.05, sustain: 0.7, release: 0.1 },  // seconds; sustain is a LEVEL 0..1
  gain: 0.9,                    // output level 0..1
  seed: 1                       // only used by the 'noise' oscillator
}
```

`sustain` and `gain` values outside `0..1` are clamped to that range.

The spec GROWS (it does not change shape) at later milestones: `filter`, `seq`,
and a `voices`/`mix` array layer on top of the same object.

## The two outputs

### (a) Offline — `render(spec, { sampleRate = 44100, duration }) → Float32Array`

Pure function. `duration` is how long the note is **held**; the buffer is
extended by the envelope's `release` so the tail isn't clipped — output length
is `round(sampleRate * (duration + release))`. No globals, no time, no I/O.
This is the path tests assert on.

### (b) Live — `connect(spec, audioContext) → { output, start, stop }` *(M4)*

Builds the equivalent Web-Audio graph:

```
OscillatorNode → GainNode (ADSR via setValueAtTime / linearRampToValueAtTime)
              → BiquadFilterNode → (caller connects .output to destination)
```

Same spec object as `render`, so the offline tests act as a spec for the live
graph. The host owns the `AudioContext` and the final `.connect(destination)`.

## Note / frequency

`note(name)` → Hz. Equal temperament, **A4 = 440 Hz**. Accepts `C4`, `A#4`,
`Bb3`, `G#5`, negative octaves, and passes numbers through unchanged (so a spec
can give `freq` as either a name or raw Hz). Internally it maps to a MIDI-style
absolute semitone index and anchors A4 = MIDI 69 = 440 Hz.

## Milestones

- **M1 — oscillators + ADSR + offline `render`** *(done)*
  Produce a clean note: correct frequency (DFT-verified), no clipping
  (`|sample| ≤ 1`), non-trivial RMS, deterministic across renders. `note()`
  helper. Headless test suite.
- **M2 — sequencer + music theory**
  `scale` / `chord` / `progression`; `sequence(spec, opts)` to render notes
  over time (steps, durations, gate). One-pole then biquad low-/high-pass
  filters. Enables melodies, arps and chord progressions; tests assert note
  onsets/offsets and per-step pitch via windowed DFT. PolyBLEP band-limiting
  for saw/square to cut aliasing.
- **M3 — SFX presets**
  Parametric presets for the mahjong table: **tile clack**, **riichi call**,
  **ツモ / ロン fanfare**, **dora flip** — each a function of dynamic params
  (`intensity`, `pitch`, `seed`) returning a spec. Tested by asserting envelope
  shape, peak and spectral centroid shift with the params. Seeded, so
  "randomized" variation (e.g. slightly different clack per tile) is still
  reproducible.
- **M4 — host wiring (netmahg)**
  `connect(spec, audioContext)` for live Web Audio. Augment netmahg's existing
  Web-Audio SFX (swap hand-built one-shots for synthkit presets) and add
  **dynamic BGM** driven by game state: tempo / mode / instrumentation track
  the **tension** (wall remaining, riichi declared, score gap, all-last round).
  Pre-bake heavy one-shots offline via `render` into `AudioBuffer`s; synthesize
  evolving BGM live.

## Mahjong / audio applications

- **SFX**: every table sound (tile draw/discard clack, riichi stick, pon/chi/
  kan call, win fanfare, dora indicator flip) becomes a small parametric spec —
  no audio asset files, infinite seeded variation, tunable per event.
- **Dynamic BGM**: a progression + arp whose tempo, scale (major → tense
  minor/diminished), filter brightness and layering are driven by live game
  tension. The same `scale`/`chord`/`progression` helpers that build melodies
  build the score.
- **Determinism**: a given game state + seed always produces the same audio, so
  the audio layer is reproducible and testable alongside the rest of the game.

## Testing philosophy

We cannot listen in CI, so a render is judged by **measuring its buffer**:

- **length** — matches `sampleRate * (duration + release)`.
- **finiteness** — no `NaN` / `Infinity`.
- **peak** — `|sample| ≤ 1` proves no clipping; `peak` large enough proves it's
  audible (not silence).
- **RMS** — in a sane band proves there's signal but it isn't railed.
- **spectrum** — a Goertzel / DFT probe confirms the intended fundamental
  dominates (M1) and, later, expected harmonics / per-step pitches (M2/M3).
- **determinism** — two renders of one spec are byte-identical.
