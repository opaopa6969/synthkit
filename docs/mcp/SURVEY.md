# MCP 化調査: synthkit

## 概要

**synthkit** は決定論的・ヘッドレステスト可能な手続き音声合成エンジンで、plain-data の synth spec を純粋関数で offline render し `Float32Array`（mono, `[-1, 1]`）を返すライブラリ。依存ゼロ・単一 ESM ファイル（`index.js`, 151 行）。M1 完了（oscillator `sine`/`saw`/`square`/`triangle`/`noise` + ADSR envelope + `render()` + `note()`）。M2〜M4（sequencer / filter / music theory / 麻雀 SFX preset / live Web Audio `connect()`）は未実装。ゲーム（`netmahg`）への組込みを前提に設計されている。

| 項目 | 値 |
|---|---|
| kind | `library` |
| existing | HTTP API: なし / CLI: なし / MCP: なし / healthz: なし / volta manifest: なし |
| proposed namespace | `synthkit` |
| runtime | node (ESM, 依存ゼロ) |

## 判定と理由

**判定: `defer`**

M1 の公開 API は `render()` と `note()` のみ。いずれも起動 1 秒以内・依存ゼロ・状態なしなので、常駐サーバにする価値が薄い。エージェントは `node -e` で直接 `import` して呼べる。

合成価値が生まれるのは M2（sequencer + music theory）や M3（麻雀 SFX preset）が実装された後。その時点で `netmahg` の SFX/BGM 生成や `kamishibai` の音声トラック合成など他サービスとの有機的組み合わせが可能になる。それまでは `defer` とし、**M2 or M3 完了を再評価のトリガ** とする。

## 公開候補

| kind | name | io | 副作用 | 長時間 | 状態 |
|---|---|---|---|---|---|
| tool | `render` | `{osc, freq, env, gain, seed} + {sampleRate, duration} → Float32Array` | none | no | 実装済 (index.js:114) |
| tool | `note` | `noteName (string \| number) → Hz (number)` | none | no | 実装済 (index.js:32) |
| tool | `sequence` | `steps[] + {sampleRate, tempo, gate} → Float32Array` | none | no | 計画 (M2) |
| tool | `scale_chord` | `root + mode/quality → [Hz, ...]` | none | no | 計画 (M2) |
| tool | `sfx` | `{type, intensity, pitch, seed} → synth spec` | none | no | 計画 (M3) |
| resource | `spec` | `synthkit://spec` — 能力の機械可読仕様 | — | — | 候補 |
| resource | `guide` | `synthkit://guide` — 使い方 | — | — | 候補 |
| skill | `game-audio-synth` | ゲーム状態から synth spec を組み立て offline render で検証可能な SFX/BGM を作る手順 (locality: repo) | — | — | 候補 |

## 組み合わせ例

1. `synthkit__render` → WAV 変換 → `kamishibai__render_start`（動画に音声トラックを追加）: M2/M3 完了後に synthkit で BGM/SFX を生成し、kamishibai で映像と合成する
2. `netmahg` のゲーム状態（tension, riichi, score）→ `synthkit__sfx` → ブラウザで再生: M3/M4 完了後に netmahg 側が synthkit の preset を呼び出し、アセットファイルなしで動的 SFX/BGM を生成する
3. `synthkit__scale_chord` → `synthkit__sequence` → `synthkit__render`: M2 完了後にスケールとコード進行からメロディを組み立て、offline でレンダして音声アセットを出す

## 依存と協調

| 相手 repo | 方向 | 能力 | 現在あるか | 備考 |
|---|---|---|---|---|
| `netmahg` | provides_to | SFX preset + dynamic BGM (M3/M4) | no | DESIGN.md M4 で netmahg への組込みを明示。netmahg は volta カタログに存在（`mahjong.unlaxer.org`, port 7074, systemd）するが MCP バックエンドなし。synthkit 側も SFX preset は未実装 (M3)。両者が揃った時点で協調の価値が生まれる。 |
| `kamishibai` | provides_to | 音声トラック (Float32Array → WAV) | yes | kamishibai は volta カタログに存在し MCP バックエンドあり（job 型 render）。synthkit が生成した音声を kamishibai の映像に合成する絵が描けるが、現在は synthkit 側にシーケンス機能がないため単音のみ。 |

## ライブラリのサーバ化

- **needed**: `false`（現時点では不要）
- **理由**: M1 の API は純粋関数 2 つのみ。`node -e` で直接呼べてサブ秒。常駐プロセス・ポート・状態管理の費用対効果が低い。M2/M3 完了後に再評価。
- **new_work**: なし（将来必要になった場合: healthz, PORT, volta.service.json, systemd unit, MCP サーバ, Float32Array → WAV/base64 出力形式）
- **runtime**: node
- **estimated_effort**: S

## リスク

- M1 のみで公開 API が 2 つ（`render`, `note`）しかなく、サーバ化しても tool の面が薄い。M2/M3 が完了するまでは常駐プロセスを立てる費用対効果が低い。
- `render()` は純粋関数・依存ゼロ・サブ秒のため、エージェントは `node -e` で直接呼べる。MCP サーバを介する恩恵（常駐・状態管理）が現状ない。
- `Float32Array` は MCP の JSON レスポンスにそのまま載らない。WAV/base64 エンコード等の出力形式設計が将来必要。
- live Web Audio（M4）はブラウザ専用で MCP サーバ（Node）からは扱えない。MCP 化するのは offline render のみ。

## 持ち主への質問

1. M2（sequencer + music theory）の完了予定はいつか？これが MCP 化の実質的トリガになる。
2. M3 の SFX preset は synthkit 側に持つか、netmahg 側に持つか？preset の所有権によって MCP サーバの置き場が変わる。
3. `render` の出力を他サービス（kamishibai 等）に渡す場合の形式（WAV / base64 / ファイルパス）の想定はあるか。
