# AGENTS.md

Context for AI coding agents working in this repository. Read the "Hard-won gotchas" section before touching the
request code; every item there is a bug that shipped and cost real debugging time.

## What this project is

A Baidu Text-to-Speech plugin for Pot (pot-app, a desktop selection-translation tool). It calls Baidu Cloud's "Short
Text Online Synthesis" API and hands the synthesized audio back to Pot for playback. The full chain (install, config,
playback) has been verified against Pot 3.0.7.

- Baidu API docs: <https://cloud.baidu.com/doc/SPEECH/s/mlbxh7xie>
- Pot plugin docs: <https://pot-app.com/docs/guide/plugin>

The deliverable is three files: `main.js` (plugin logic), `info.json` (config definition), `baidu.svg` (icon). They get
zipped and renamed to `.potext` for distribution.

## Hard constraints

**No build system.** No package.json, no npm dependencies, no import/export. Pot loads `main.js` with `eval()`, so:

- It must define a global `async function tts(text, lang, options = {})` — no module.exports
- Everything lives in one file; split logic with plain functions

**The return type is fixed.** Pot's playback code runs `new Uint8Array(data).buffer`, so `tts()` must return a plain
array of numbers 0-255. Normalize ArrayBuffer / Uint8Array / string into number[] before returning.

**Throw strings, not Errors.** Pot only displays thrown strings to the user; throwing an Error object gives them nothing
useful.

## Runtime injected by Pot

`options.config` holds user settings; `options.utils` holds injected tools. Do not assume browser APIs exist:

| Member                                                 | Notes                                                                                           |
|--------------------------------------------------------|-------------------------------------------------------------------------------------------------|
| `utils.tauriFetch`                                     | Tauri v1 `http.fetch`; options accept `{ method, headers, body, query, timeout, responseType }` |
| `utils.http.Body`                                      | `form()` / `text()` / `json()` request body builders                                            |
| `utils.run`, `utils.cacheDir`, `utils.pluginDir`, etc. | See pot-desktop source, `src/utils/invoke_plugin.js`                                            |

`responseType`: 1=JSON (default), 2=Text, 3=Binary. **timeout is in seconds**, not milliseconds.

## Hard-won gotchas

1. **Tauri v1's `Body.form()` only accepts string values.** Numbers fail deserialization on the Rust side and the whole
   request is rejected, with an error that looks exactly like an ordinary network failure. Convert every form field
   with `String()`.
2. **With responseType=3, error responses are bytes too.** When synthesis fails, Baidu returns JSON (containing err_no)
   but still as a binary response. Decode the bytes as UTF-8, try JSON.parse, check for err_no — that is how you tell
   audio apart from errors.
3. **Pot's select component sends strings.** `"5"` is not `5`. Run `Number()` plus range validation when reading config;
   on out-of-range values, fall back to defaults instead of throwing.
4. **JS objects force pure numeric keys into ascending numeric order** — the order they were written in the JSON file
   does not matter. The `info.json` options therefore use keys like `"5.0"` to keep "5 (normal)" in first place, because
   Pot shows the first option for unconfigured settings. `Number("5.0")` converts losslessly, so the parsing code needs
   no changes.
5. **Basic voices (per=0/1/3/4) only support volume 0-9**; premium and higher voices support 0-15. Out-of-range volume
   makes Baidu return error 501. The plugin clamps volume per voice (falls back to 5), and the 501 message spells out
   this cause.
6. **Raw PCM (aue=4/5) fails silently.** Pot's `decodeAudioData` has no error callback; headerless PCM simply produces
   no sound. Only mp3 (3) and wav (6) are allowed through.
7. **tex needs exactly one manual `encodeURIComponent`.** Baidu's docs say "two urlencode" because their sample builds
   the POST body by hand, with no transport encoding. `Body.form()` is different: Tauri hands it to reqwest `.form()`,
   which percent-encodes once more, and Baidu then decodes twice — so one manual encode balances out. Two leaves a
   literal `%E4%BD%A0` that gets read out character by character; Chinese comes back as nonsense while plain ASCII
   still sounds fine.
8. **Zips produced by PowerShell's `Compress-Archive` fail to extract in Pot** (Rust zip crate compatibility; the only
   symptom is a red toast that vanishes instantly, leaving an empty plugin directory). Pack with Python `zipfile` +
   `ZIP_STORED`; the three files must sit at the zip root, no folders.
9. **The `.potext` file name determines the installed directory name** (not the id in info.json). Keeping them identical
   is the safe move.

## How to verify changes

The repo has no test framework, and none should be added. After changing code:

1. Syntax: `node --check main.js`
2. Config consistency: parse info.json, check every needs key is actually read in main.js, the icon file exists, JSON is
   valid
3. Behavioral regression: write a Node script (in a system temp directory, **never inside this repo**), grab the
   function with `eval(main.js source + '; tts;')`, and stub utils yourself — a fake `tauriFetch` that returns a
   controllable `{ok, status, data}` or rejects. Cover: happy path (assert a number[] that survives `new Uint8Array()`),
   request contents (single-encoded tex, all-string form, responseType, timeout), config fallbacks, every error branch,
   token caching (one fetch per credential, refetch when a key changes)
4. All cases green before delivering — running the happy path alone does not count

## Baidu API quick reference

| Item                                                                     | Value                                                                                                                                   |
|--------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------|
| Console (create app, get API Key/Secret Key, activate voice permissions) | <https://console.bce.baidu.com/ai-engine/speech/overview/index?type=1>                                                                  |
| Auth                                                                     | `POST https://aip.baidubce.com/oauth/2.0/token` with `grant_type=client_credentials&client_id=&client_secret=`                          |
| Synthesis                                                                | `POST https://tsn.baidu.com/text2audio`, form submission                                                                                |
| Required fields                                                          | tex (one manual encodeURIComponent; Tauri adds the second) / tok / cuid (≤60 chars, randomly generated) / ctp=1 / lan=zh               |
| Optional                                                                 | spd, pit, vol 0-15, default 5 (basic voices cap vol at 9); per voice selection; aue 3=mp3, 6=wav                                        |
| Text limit                                                               | Under 1024 GBK bytes; over 120 bytes bills an extra call. The code estimates the length and rejects oversize text instead of truncating |
| Token caching                                                            | Expires 5 minutes before expires_in; cache is bound to the credentials; changing either key forces a refetch                            |

Common err_no values: 500 timeout or unsupported input, 501 bad parameter (check volume against the basic-voice cap
first), 502 token validation failed, 503 non-GBK characters in text, 513 special symbols, 6 no permission (premium/LLM
voices need separate activation in the Baidu console), 13 QPS exceeded. Error messages are written in Chinese, always
keep err_no and sn, and always point the user at an actionable fix.

## Code and comment style

- Plain, obvious code; no cleverness. A programming beginner must be able to follow it
- Comments are conversational and explain why, not what; no boilerplate phrases like "note that" or "here we"
- No new build config, npm dependencies, or test files; no task-log / progress-report markdown files in the repo
- `.workbuddy/` is a local working directory and gitignored — never reference it or commit it

## Packaging and release

Put `main.js`, `info.json`, `baidu.svg` at the zip root and rename the zip to `plugin.com.pot-app.baidu_tts.potext`.
GitHub Actions (`on: push`, any branch) builds it automatically; pushing a tag also uploads it to a Release. For local
packing use Python zipfile STORED (reason: gotcha 8).
