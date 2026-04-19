# HireShield Chrome Extension

Hackathon-first Chrome extension for live interview trust scoring on Google Meet, Zoom, Microsoft Teams, YouTube, and a local demo dashboard. Detection runs **fully on-device** via [Transformers.js](https://github.com/huggingface/transformers.js) using the [`onnx-community/Deep-Fake-Detector-v2-Model-ONNX`](https://huggingface.co/onnx-community/Deep-Fake-Detector-v2-Model-ONNX) model. No API tokens, no per-frame network calls, no rate limits.

## Load the extension

1. Open `chrome://extensions` in Google Chrome.
2. Enable **Developer mode** in the top-right corner.
3. Click **Load unpacked**.
4. Select the folder: `hireshield-extension`

## First-run note

The first time you press Start Monitoring, the extension downloads the ONNX model weights from Hugging Face Hub (~50 MB) and caches them in the browser. Subsequent runs load instantly from the cache — the model never leaves your machine after that.

## Recommended live flow

1. Open a supported page (Meet, Zoom, Teams, YouTube, or `localhost:3000`).
2. Click the HireShield extension icon.
3. Make sure **Demo mode** is OFF.
4. Click **Start Monitoring**.
5. Watch the injected sidebar on the right side of the page:
   - Frames are sampled from the tab every 2.5 seconds.
   - Each frame is cropped around the detected face (falls back to a center crop) and resized to 224×224.
   - The deepfake classifier runs locally via WebGPU (if available) or WASM.
   - Trust score = the model's `Realism` confidence (0–100%).
   - Verdict: `likely_authentic` if realism ≥ 0.7, `likely_deepfake` if ≤ 0.3, otherwise `uncertain`.

## Demo mode

Demo mode replays staged verdicts (94 → 58 → 22) so you can show the UI without running the model. Enable via:

- The popup's Demo mode toggle.
- A URL query param on the target page: `?hireshieldDemo=1`, `?demoMode=true`, or `?demo=1`.

## Local inference pipeline

With demo mode off, HireShield will:

1. Start tab capture from the popup click gesture (Chrome requirement).
2. Open an offscreen document that hosts Transformers.js and a hidden `<video>` element for the tab stream.
3. On first start, download `onnx-community/Deep-Fake-Detector-v2-Model-ONNX` weights (q4f16 on WebGPU, q8 on WASM fallback).
4. Every 2.5 seconds, draw the current frame to a canvas. If the browser has the Shape Detection `FaceDetector` API, crop tight to the detected face with padding; otherwise take a center square crop.
5. Run the classifier locally and post the verdict to the service worker.
6. Render the verdict in the sidebar.

No frame bytes or predictions are ever uploaded.

## What to test

1. Extension loads without manifest errors.
2. Popup opens and reflects the current page, with no Hugging Face token field visible.
3. Demo mode toggle persists.
4. One-click start injects the sidebar into the current page.
5. Live mode: on first run, the sidebar shows model-download progress; on subsequent runs, the first verdict lands within a few seconds.
6. Live mode: trust score on a talking-head YouTube video is typically high (`likely_authentic`).
7. Pause / resume / end session work from the sidebar.
8. YouTube video playback works as a capture test surface.

## Known limitations

- First run requires internet to download the ONNX weights from Hugging Face Hub. After caching, the extension is fully offline.
- Real capture depends on Chrome tab capture availability on the active interview tab.
- WebGPU support varies by Chrome version and GPU driver; the extension falls back to WASM (slower but works everywhere).
- The model analyzes single frames, not motion — lip-sync artifacts that require temporal context are not captured.
- Service worker restarts can interrupt a live session; demo mode is the reliable stage path.
- Sidebar uses Google Fonts when available, with serif / system fallbacks if fonts are blocked.
- `icons/icon-16.png`, `icons/icon-48.png`, and `icons/icon-128.png` are intentionally not included yet. Add branded PNG assets before packaging if you want a custom toolbar icon.
