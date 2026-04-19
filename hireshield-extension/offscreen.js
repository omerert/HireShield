import {
  pipeline,
  env,
  RawImage
} from "./vendor/transformers/transformers.min.js";

const MODEL_ID = "onnx-community/Deep-Fake-Detector-v2-Model-ONNX";
const FRAME_INTERVAL_MS = 2500;
const MODEL_INPUT_SIZE = 224;
const FACE_CROP_PADDING = 0.25;

env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useBrowserCache = true;
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL(
  "vendor/transformers/"
);
env.backends.onnx.wasm.numThreads = 1;

let classifierPromise = null;
let stream = null;
let videoElement = null;
let sourceCanvas = null;
let sourceContext = null;
let outputCanvas = null;
let outputContext = null;
let faceDetector = null;
let faceDetectorAttempted = false;
let captureTimer = null;
let currentTabId = null;
let active = false;
let paused = false;
let inFlight = false;

async function sendStatus(stage, detail) {
  if (!currentTabId) {
    return;
  }

  await chrome.runtime
    .sendMessage({
      type: "OFFSCREEN_STATUS",
      tabId: currentTabId,
      stage,
      detail
    })
    .catch(() => undefined);
}

async function sendError(message) {
  if (!currentTabId) {
    return;
  }

  await chrome.runtime
    .sendMessage({
      type: "OFFSCREEN_RECORDING_ERROR",
      tabId: currentTabId,
      error: message
    })
    .catch(() => undefined);
}

function getClassifier() {
  if (classifierPromise) {
    return classifierPromise;
  }

  classifierPromise = (async () => {
    const attempt = async (dtype, device) => {
      return pipeline("image-classification", MODEL_ID, {
        dtype,
        device,
        progress_callback: (info) => {
          if (!info) return;
          if (info.status === "progress" && typeof info.progress === "number") {
            sendStatus(
              "model_loading",
              `Downloading deepfake model: ${info.file || "weights"} (${Math.round(
                info.progress
              )}%)`
            );
          } else if (info.status === "done") {
            sendStatus(
              "model_loading",
              `Deepfake model ready (${info.file || "weights"}).`
            );
          } else if (info.status === "ready") {
            sendStatus("model_ready", "Deepfake model fully loaded.");
          }
        }
      });
    };

    try {
      return await attempt("q4f16", "webgpu");
    } catch (error) {
      await sendStatus(
        "model_loading",
        "WebGPU unavailable, falling back to WASM + INT8 quantization."
      );
      try {
        return await attempt("q8", "wasm");
      } catch (wasmError) {
        classifierPromise = null;
        throw wasmError;
      }
    }
  })();

  return classifierPromise;
}

function clearTimer() {
  if (captureTimer) {
    clearInterval(captureTimer);
    captureTimer = null;
  }
}

function stopStream() {
  if (!stream) {
    return;
  }

  for (const track of stream.getTracks()) {
    track.stop();
  }
  stream = null;
}

function teardownVideo() {
  if (videoElement) {
    videoElement.pause();
    videoElement.srcObject = null;
    videoElement.remove();
    videoElement = null;
  }
}

function ensureCanvases(width, height) {
  if (!sourceCanvas) {
    sourceCanvas = document.createElement("canvas");
    sourceContext = sourceCanvas.getContext("2d", { willReadFrequently: true });
  }
  sourceCanvas.width = Math.max(1, width);
  sourceCanvas.height = Math.max(1, height);

  if (!outputCanvas) {
    outputCanvas = document.createElement("canvas");
    outputContext = outputCanvas.getContext("2d", { willReadFrequently: true });
    outputCanvas.width = MODEL_INPUT_SIZE;
    outputCanvas.height = MODEL_INPUT_SIZE;
  }
}

function ensureFaceDetector() {
  if (faceDetectorAttempted) {
    return faceDetector;
  }
  faceDetectorAttempted = true;

  if (typeof window !== "undefined" && "FaceDetector" in window) {
    try {
      faceDetector = new window.FaceDetector({
        fastMode: true,
        maxDetectedFaces: 1
      });
    } catch (error) {
      faceDetector = null;
    }
  }
  return faceDetector;
}

async function detectFaceBox(canvas) {
  const detector = ensureFaceDetector();
  if (!detector) {
    return null;
  }

  try {
    const faces = await detector.detect(canvas);
    if (faces && faces.length) {
      const box = faces[0].boundingBox;
      return {
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height
      };
    }
  } catch (error) {
    // Face detector can throw on some canvas states; fall back silently.
  }
  return null;
}

function centerCropBox(width, height) {
  const side = Math.min(width, height) * 0.75;
  return {
    x: (width - side) / 2,
    y: Math.max(0, (height - side) / 2 - height * 0.05),
    width: side,
    height: side
  };
}

function expandBoxToSquare(box, canvasWidth, canvasHeight) {
  const padding = FACE_CROP_PADDING;
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  const side = Math.max(box.width, box.height) * (1 + padding * 2);

  const x = Math.max(0, Math.min(canvasWidth - side, centerX - side / 2));
  const y = Math.max(0, Math.min(canvasHeight - side, centerY - side / 2));

  return {
    x: Math.max(0, x),
    y: Math.max(0, y),
    width: Math.min(side, canvasWidth),
    height: Math.min(side, canvasHeight)
  };
}

async function analyzeCurrentFrame() {
  if (!active || paused || inFlight || !videoElement || !stream) {
    return;
  }

  if (videoElement.readyState < 2 || !videoElement.videoWidth) {
    return;
  }

  inFlight = true;
  const startedAt = performance.now();

  try {
    const srcWidth = videoElement.videoWidth;
    const srcHeight = videoElement.videoHeight;
    ensureCanvases(srcWidth, srcHeight);
    sourceContext.drawImage(videoElement, 0, 0, srcWidth, srcHeight);

    const detectedBox = await detectFaceBox(sourceCanvas);
    const cropBox = detectedBox
      ? expandBoxToSquare(detectedBox, srcWidth, srcHeight)
      : centerCropBox(srcWidth, srcHeight);

    outputContext.drawImage(
      sourceCanvas,
      cropBox.x,
      cropBox.y,
      cropBox.width,
      cropBox.height,
      0,
      0,
      MODEL_INPUT_SIZE,
      MODEL_INPUT_SIZE
    );

    const imageData = outputContext.getImageData(
      0,
      0,
      MODEL_INPUT_SIZE,
      MODEL_INPUT_SIZE
    );
    const rawImage = new RawImage(
      imageData.data,
      imageData.width,
      imageData.height,
      4
    );

    const classifier = await getClassifier();
    const predictions = await classifier(rawImage, { top_k: 2 });

    const elapsedMs = Math.max(1, Math.round(performance.now() - startedAt));
    await chrome.runtime.sendMessage({
      type: "OFFSCREEN_CLASSIFIED",
      tabId: currentTabId,
      predictions,
      faceDetected: Boolean(detectedBox),
      cropSource: detectedBox ? "face_detector" : "center_crop",
      elapsedMs
    });
  } catch (error) {
    await sendError(error?.message || "Local inference failed.");
  } finally {
    inFlight = false;
  }
}

function scheduleCapture() {
  clearTimer();
  captureTimer = setInterval(() => {
    analyzeCurrentFrame().catch(() => undefined);
  }, FRAME_INTERVAL_MS);
}

async function createStream(streamId) {
  stopStream();
  await sendStatus("stream_request", "Requesting a tab media stream from Chrome.");

  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
        maxWidth: 1280,
        maxHeight: 720,
        maxFrameRate: 15
      }
    }
  });

  const [videoTrack] = stream.getVideoTracks();
  if (videoTrack) {
    await sendStatus(
      "stream_ready",
      "Tab media stream acquired. Starting local analysis."
    );
    videoTrack.onended = () => {
      if (!currentTabId || !active) {
        return;
      }
      chrome.runtime
        .sendMessage({
          type: "OFFSCREEN_STREAM_ENDED",
          tabId: currentTabId
        })
        .catch(() => undefined);
    };
  }

  videoElement = document.createElement("video");
  videoElement.muted = true;
  videoElement.playsInline = true;
  videoElement.autoplay = true;
  videoElement.srcObject = stream;
  document.body.appendChild(videoElement);

  await videoElement.play().catch(() => undefined);

  await new Promise((resolve) => {
    if (videoElement.readyState >= 2 && videoElement.videoWidth) {
      resolve();
      return;
    }
    const onReady = () => {
      videoElement.removeEventListener("loadeddata", onReady);
      resolve();
    };
    videoElement.addEventListener("loadeddata", onReady);
    setTimeout(resolve, 2000);
  });
}

async function startCapture(tabId, streamId) {
  stopCapture();
  currentTabId = tabId;
  active = true;
  paused = false;

  await sendStatus(
    "model_loading",
    "Preparing local deepfake model (first run may download ~50 MB)."
  );

  try {
    await getClassifier();
  } catch (error) {
    await sendError(error?.message || "Failed to load local deepfake model.");
    throw error;
  }

  await createStream(streamId);
  await sendStatus(
    "recorder_started",
    "Local inference running. Sampling the tab every 2.5 seconds."
  );
  scheduleCapture();
  analyzeCurrentFrame().catch(() => undefined);
}

function pauseCapture() {
  if (!active || paused) {
    return;
  }

  paused = true;
  clearTimer();
  sendStatus("paused", "Frame sampling paused.").catch(() => undefined);
}

function resumeCapture() {
  if (!active || !paused) {
    return;
  }

  paused = false;
  sendStatus("resumed", "Frame sampling resumed.").catch(() => undefined);
  scheduleCapture();
  analyzeCurrentFrame().catch(() => undefined);
}

function stopCapture() {
  active = false;
  paused = false;
  clearTimer();
  sendStatus("stopped", "Frame sampling stopped.").catch(() => undefined);

  teardownVideo();
  stopStream();
  currentTabId = null;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handle = async () => {
    if (message?.target !== "offscreen") {
      return { ok: false, error: "Message not intended for offscreen inference." };
    }

    switch (message?.type) {
      case "OFFSCREEN_START_RECORDING":
        await startCapture(message.tabId, message.streamId);
        return { ok: true };
      case "OFFSCREEN_PAUSE_RECORDING":
        pauseCapture();
        return { ok: true };
      case "OFFSCREEN_RESUME_RECORDING":
        resumeCapture();
        return { ok: true };
      case "OFFSCREEN_STOP_RECORDING":
        stopCapture();
        return { ok: true };
      default:
        return { ok: false, error: "Unknown offscreen message" };
    }
  };

  handle()
    .then((response) => sendResponse(response))
    .catch(async (error) => {
      await sendError(error?.message || "Offscreen inference failed.");
      sendResponse({
        ok: false,
        error: error?.message || "Offscreen inference failed."
      });
    });

  return true;
});
