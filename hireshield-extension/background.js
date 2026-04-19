import { DEMO_SCANS, DEMO_TIMELINE_MS, cloneDemoScan } from "./demo-data.js";

const STORAGE_KEY = "hireshieldSessions";
const SETTINGS_KEY = "hireshieldSettings";
const LOCAL_MODEL_ID = "onnx-community/Deep-Fake-Detector-v2-Model-ONNX";
const SUPPORTED_PROTOCOLS = [
  "https://meet.google.com/",
  "https://teams.microsoft.com/",
  "https://www.youtube.com/",
  "https://youtube.com/",
  "http://localhost:3000/"
];

let stateLoadedPromise;
let sessions = {};
let settings = {
  demoMode: false
};
let creatingOffscreen;

const runtimeByTab = new Map();

function createPipelineState(demoMode = false) {
  return {
    captureStage: demoMode ? "demo" : "idle",
    uploadStage: demoMode ? "demo" : "idle",
    backendStage: demoMode ? "demo" : "idle",
    detail: demoMode ? "Demo sequence armed." : "Waiting to start.",
    lastHttpStatus: null,
    lastBackendLatencyMs: null,
    lastError: ""
  };
}

function defaultSession(tabId, demoMode = false) {
  const now = Date.now();

  return {
    tabId,
    active: false,
    paused: false,
    ended: false,
    demoMode,
    startedAt: now,
    updatedAt: now,
    endedAt: null,
    currentScan: null,
    history: [],
    errorMessage: "",
    errorCode: "",
    awaitingFirstScan: true,
    scanInProgress: false,
    statusNote: demoMode
      ? "Scanning in demo mode. First verdict arrives in about 15 seconds."
      : "Waiting to capture first clip.",
    clipsCaptured: 0,
    lastClipCapturedAt: null,
    pipeline: createPipelineState(demoMode),
    debugTrail: [],
    demoProgress: {
      stepIndex: 0,
      elapsedBeforePauseMs: 0,
      lastResumedAt: now
    }
  };
}

async function ensureStateLoaded() {
  if (!stateLoadedPromise) {
    stateLoadedPromise = chrome.storage.local
      .get([STORAGE_KEY, SETTINGS_KEY])
      .then((stored) => {
        sessions = stored[STORAGE_KEY] || {};
        settings = {
          demoMode: false,
          ...(stored[SETTINGS_KEY] || {})
        };
        // Scrub legacy fields that are no longer used.
        if ("hfToken" in settings) {
          delete settings.hfToken;
        }
      })
      .catch(() => {
        sessions = {};
      });
  }

  await stateLoadedPromise;
}

async function persistState() {
  await chrome.storage.local.set({
    [STORAGE_KEY]: sessions,
    [SETTINGS_KEY]: settings
  });
}

function sessionFor(tabId) {
  const key = String(tabId);
  return sessions[key] || null;
}

function setSession(tabId, session) {
  sessions[String(tabId)] = session;
}

function deleteSession(tabId) {
  delete sessions[String(tabId)];
}

function isSupportedUrl(url = "") {
  if (SUPPORTED_PROTOCOLS.some((prefix) => url.startsWith(prefix))) {
    return true;
  }

  return /^https:\/\/[A-Za-z0-9.-]+\.zoom\.us\//.test(url);
}

function isDemoQueryEnabled(url = "") {
  try {
    const params = new URL(url).searchParams;
    const raw = (
      params.get("hireshieldDemo") ||
      params.get("demoMode") ||
      params.get("demo") ||
      ""
    ).toLowerCase();

    return ["1", "true", "on", "yes"].includes(raw);
  } catch (error) {
    return false;
  }
}

function getRuntime(tabId) {
  if (!runtimeByTab.has(tabId)) {
    runtimeByTab.set(tabId, {
      inFlight: false,
      queuedFrame: null,
      controller: null,
      streamActive: false,
      requestStartedAt: null
    });
  }

  return runtimeByTab.get(tabId);
}

function clearRuntime(tabId) {
  const runtime = runtimeByTab.get(tabId);
  if (runtime?.controller) {
    runtime.controller.abort();
  }

  runtimeByTab.delete(tabId);
}

function setPipeline(session, updates) {
  session.pipeline = {
    ...createPipelineState(session.demoMode),
    ...(session.pipeline || {}),
    ...updates
  };
}

function pushDebugEvent(session, message, level = "info") {
  session.debugTrail = [
    ...(session.debugTrail || []),
    {
      timestamp: Date.now(),
      level,
      message
    }
  ].slice(-8);

  const logger =
    level === "error" ? console.error : level === "warn" ? console.warn : console.info;
  logger(`[HireShield][tab ${session.tabId}] ${message}`);
}

function handleOffscreenStatus(tabId, stage, detail = "") {
  const session = sessionFor(tabId);
  if (!session) {
    return null;
  }

  const pipelineMap = {
    model_loading: {
      captureStage: "arming",
      uploadStage: "idle",
      backendStage: "loading_model"
    },
    model_ready: {
      captureStage: "arming",
      uploadStage: "idle",
      backendStage: "model_ready"
    },
    stream_request: {
      captureStage: "arming",
      uploadStage: "idle",
      backendStage: "model_ready"
    },
    stream_ready: {
      captureStage: "recording",
      uploadStage: "idle",
      backendStage: "model_ready"
    },
    recorder_started: {
      captureStage: "recording",
      uploadStage: "idle",
      backendStage: "model_ready"
    },
    paused: {
      captureStage: "paused",
      uploadStage: "idle",
      backendStage: "idle"
    },
    resumed: {
      captureStage: "recording",
      uploadStage: "idle",
      backendStage: "model_ready"
    },
    stopped: {
      captureStage: "idle",
      uploadStage: "idle",
      backendStage: "idle"
    }
  };

  const mapped = pipelineMap[stage];
  if (mapped) {
    setPipeline(session, {
      ...mapped,
      detail: detail || session.pipeline?.detail || "Recorder update received."
    });
  } else if (detail) {
    setPipeline(session, {
      detail
    });
  }

  if (detail) {
    pushDebugEvent(session, detail, "info");
    session.statusNote = detail;
  }

  session.updatedAt = Date.now();
  setSession(tabId, session);
  return session;
}

function verdictCopy(scan) {
  if (scan?.noFaceDetected) {
    return {
      title: "No face detected",
      subtitle: "We could not verify a visible face in the latest clip.",
      tone: "neutral"
    };
  }

  switch (scan?.verdict) {
    case "likely_authentic":
      return {
        title: "Likely authentic",
        subtitle: "Signal confidence looks healthy across the latest scan.",
        tone: "positive"
      };
    case "uncertain":
      return {
        title: "Uncertain",
        subtitle: "Some visual artifacts need a closer review.",
        tone: "caution"
      };
    case "likely_deepfake":
      return {
        title: "Likely deepfake",
        subtitle: "The latest clip contains patterns consistent with synthesis artifacts.",
        tone: "danger"
      };
    default:
      return {
        title: "Awaiting scan",
        subtitle: "We are still collecting enough footage to score this interview.",
        tone: "neutral"
      };
  }
}

function normalizeScan(raw, source = "backend") {
  if (source === "demo") {
    const facesDetected =
      typeof raw?.faces_detected === "number" ? raw.faces_detected : null;
    const hasFace = facesDetected === null ? true : facesDetected > 0;
    const trustScore =
      typeof raw?.trust_score === "number"
        ? Math.max(0, Math.min(100, Math.round(raw.trust_score)))
        : null;

    return {
      scanId: raw?.scan_id || `scan_${Date.now()}`,
      source,
      trustScore: hasFace ? trustScore : null,
      verdict: hasFace ? raw?.verdict || "uncertain" : "no_face",
      deepfakeProbability:
        typeof raw?.deepfake_probability === "number"
          ? raw.deepfake_probability
          : null,
      facesDetected,
      flaggedMoments: Array.isArray(raw?.flagged_timestamps)
        ? raw.flagged_timestamps.map((moment) => ({
            start: typeof moment.start === "number" ? moment.start : 0,
            end: typeof moment.end === "number" ? moment.end : 0,
            reason: moment.reason || "Anomaly detected"
          }))
        : [],
      receivedAt: Date.now(),
      noFaceDetected: !hasFace
    };
  }

  const predictions = Array.isArray(raw) ? raw : [];
  const byLabel = predictions.reduce((acc, item) => {
    if (item && typeof item.label === "string" && typeof item.score === "number") {
      acc[item.label.toLowerCase()] = item.score;
    }
    return acc;
  }, {});

  // v1 used "real"/"fake"; v2 uses "realism"/"deepfake". Accept either.
  const realScore =
    typeof byLabel.realism === "number"
      ? byLabel.realism
      : typeof byLabel.real === "number"
        ? byLabel.real
        : null;
  const fakeScore =
    typeof byLabel.deepfake === "number"
      ? byLabel.deepfake
      : typeof byLabel.fake === "number"
        ? byLabel.fake
        : null;

  const trustScore =
    realScore === null ? null : Math.max(0, Math.min(100, Math.round(realScore * 100)));

  let verdict = "uncertain";
  if (realScore !== null) {
    if (realScore >= 0.7) {
      verdict = "likely_authentic";
    } else if (realScore <= 0.3) {
      verdict = "likely_deepfake";
    }
  }

  return {
    scanId: `hf_${Date.now()}`,
    source,
    trustScore,
    verdict,
    deepfakeProbability: fakeScore,
    facesDetected: null,
    flaggedMoments: [],
    receivedAt: Date.now(),
    noFaceDetected: false,
    rawPredictions: predictions
  };
}

function publicSession(session) {
  if (!session) {
    return null;
  }

  const verdict = verdictCopy(session.currentScan);

  return {
    ...session,
    verdictTitle: verdict.title,
    verdictSubtitle: verdict.subtitle,
    tone: verdict.tone
  };
}

async function pushSessionUpdate(tabId) {
  const state = publicSession(sessionFor(tabId));
  if (!state) {
    return;
  }

  try {
    await ensureContentScript(tabId);
    await chrome.tabs.sendMessage(tabId, {
      type: "HIRESHIELD_SESSION_UPDATE",
      state
    });
  } catch (error) {
    // The content script may not be ready yet. Sidebar load will rehydrate from state.
  }
}

async function ensureContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });
  } catch (error) {
    if (!String(error?.message || "").includes("Cannot access")) {
      // Ignore duplicate injection and transient frame errors.
    }
  }
}

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL("offscreen.html");

  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime
      .getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [offscreenUrl]
      })
      .catch(() => []);

    if (contexts.length) {
      return;
    }
  }

  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }

  creatingOffscreen = chrome.offscreen
    .createDocument({
      url: "offscreen.html",
      reasons: ["USER_MEDIA"],
      justification:
        "Sample tab video frames and run local deepfake inference via Transformers.js."
    })
    .finally(() => {
      creatingOffscreen = null;
    });

  await creatingOffscreen;
}

async function maybeCloseOffscreen() {
  const activeRealSession = Object.values(sessions).some(
    (session) => session.active && !session.demoMode
  );

  if (activeRealSession) {
    return;
  }

  try {
    await chrome.offscreen.closeDocument();
  } catch (error) {
    // Safe to ignore when the offscreen document is already gone.
  }
}

function currentDemoElapsedMs(session) {
  if (!session?.demoMode) {
    return 0;
  }

  if (session.paused || !session.active) {
    return session.demoProgress.elapsedBeforePauseMs;
  }

  return (
    session.demoProgress.elapsedBeforePauseMs +
    (Date.now() - session.demoProgress.lastResumedAt)
  );
}

function applyScanToSession(session, scan, statusNote = "") {
  session.currentScan = scan;
  session.awaitingFirstScan = false;
  session.scanInProgress = false;
  session.errorMessage = "";
  session.errorCode = "";
  session.updatedAt = Date.now();
  session.statusNote = statusNote || "Scan received";
  setPipeline(session, {
    captureStage:
      session.active && !session.paused && !session.demoMode ? "recording" : "idle",
    uploadStage: session.demoMode ? "demo" : "complete",
    backendStage: session.demoMode ? "demo" : "responded",
    detail: scan.noFaceDetected
      ? "Backend returned a result, but no face was detected in the clip."
      : "Backend verdict received successfully.",
    lastError: ""
  });
  pushDebugEvent(
    session,
    scan.noFaceDetected
      ? `Scan ${scan.scanId} completed with no face detected.`
      : `Scan ${scan.scanId} received.`
  );

  session.history = [...session.history, scan]
    .sort((left, right) => left.receivedAt - right.receivedAt)
    .slice(-5);
}

function describeInferenceError(rawMessage = "") {
  const lower = rawMessage.toLowerCase();

  if (lower.includes("failed to fetch") || lower.includes("network")) {
    return {
      code: "model_download_failed",
      userMessage:
        "Could not download the deepfake model from Hugging Face. Check your internet connection and retry.",
      detail:
        rawMessage ||
        `The extension could not fetch weights for ${LOCAL_MODEL_ID} from huggingface.co.`
    };
  }

  if (lower.includes("webgpu") || lower.includes("wasm")) {
    return {
      code: "model_backend_failed",
      userMessage: "Local inference backend failed to initialize. Retry or update Chrome.",
      detail: rawMessage || "Neither WebGPU nor WASM backend could start Transformers.js."
    };
  }

  return {
    code: "local_inference_error",
    userMessage: "Local deepfake inference failed. Try stopping and restarting monitoring.",
    detail: rawMessage || "An unexpected error occurred during local inference."
  };
}

function nextDemoDelayText(session) {
  const nextIndex = session?.demoProgress?.stepIndex ?? 0;
  if (nextIndex >= DEMO_TIMELINE_MS.length) {
    return "Demo sequence complete.";
  }

  const elapsed = currentDemoElapsedMs(session);
  const remainingMs = Math.max(0, DEMO_TIMELINE_MS[nextIndex] - elapsed);
  const remainingSeconds = Math.max(1, Math.ceil(remainingMs / 1000));

  return `Next demo verdict in about ${remainingSeconds} seconds.`;
}

async function advanceDemoState(tabId) {
  const session = sessionFor(tabId);
  if (!session?.demoMode) {
    return session;
  }

  const elapsed = currentDemoElapsedMs(session);

  while (
    session.demoProgress.stepIndex < DEMO_SCANS.length &&
    elapsed >= DEMO_TIMELINE_MS[session.demoProgress.stepIndex]
  ) {
    const nextIndex = session.demoProgress.stepIndex;
    const scan = normalizeScan(cloneDemoScan(nextIndex), "demo");

    applyScanToSession(
      session,
      scan,
      nextIndex === DEMO_SCANS.length - 1
        ? "Demo sequence complete"
        : "Demo scan ready"
    );

    session.demoProgress.stepIndex += 1;
    session.scanInProgress =
      session.active &&
      !session.paused &&
      session.demoProgress.stepIndex < DEMO_SCANS.length;
    session.statusNote =
      session.demoProgress.stepIndex < DEMO_SCANS.length
        ? nextDemoDelayText(session)
        : "Demo sequence complete";
    setPipeline(session, {
      captureStage: "demo",
      uploadStage: "demo",
      backendStage: "demo",
      detail:
        session.demoProgress.stepIndex < DEMO_SCANS.length
          ? nextDemoDelayText(session)
          : "Demo sequence complete.",
      lastError: ""
    });
    setSession(tabId, session);
    await persistState();
    await pushSessionUpdate(tabId);
  }

  return session;
}

async function handleClassifiedFrame(tabId, message) {
  const session = sessionFor(tabId);
  if (!session || session.demoMode || !session.active || session.paused) {
    return;
  }

  session.clipsCaptured += 1;
  session.lastClipCapturedAt = Date.now();
  session.errorMessage = "";
  session.errorCode = "";

  const predictions = Array.isArray(message?.predictions) ? message.predictions : [];
  const nextScan = normalizeScan(predictions, "local_transformers");
  nextScan.facesDetected = message?.faceDetected ? 1 : 0;
  nextScan.cropSource = message?.cropSource || "center_crop";
  nextScan.elapsedMs = typeof message?.elapsedMs === "number" ? message.elapsedMs : null;

  applyScanToSession(session, nextScan, "Local verdict received");

  const cropNote = message?.faceDetected ? "face-cropped" : "center-cropped (no face detected)";
  const latencyMs = nextScan.elapsedMs || 0;
  setPipeline(session, {
    captureStage:
      session.active && !session.paused ? "recording" : "idle",
    uploadStage: "complete",
    backendStage: "responded",
    detail: `Local inference in ${Math.max(1, Math.round(latencyMs))} ms — real ${
      nextScan.trustScore ?? 0
    }%, fake ${((nextScan.deepfakeProbability ?? 0) * 100).toFixed(0)}% (${cropNote}).`,
    lastHttpStatus: null,
    lastBackendLatencyMs: latencyMs,
    lastError: ""
  });

  setSession(tabId, session);
  await persistState();
  await pushSessionUpdate(tabId);
}

async function startRealMonitoring({ tabId, streamId }) {
  const session = sessionFor(tabId);
  if (!session) {
    return;
  }

  try {
    setPipeline(session, {
      captureStage: "arming",
      uploadStage: "idle",
      backendStage: "idle",
      detail: "Creating the offscreen recorder document.",
      lastError: ""
    });
    pushDebugEvent(session, "Creating offscreen recorder document.");
    setSession(tabId, session);
    await persistState();
    await pushSessionUpdate(tabId);

    await ensureOffscreenDocument();

    if (!streamId) {
      throw new Error(
        "Live capture must be started from the extension popup. Chrome requires the popup click gesture for tabCapture on this tab."
      );
    }

    const effectiveStreamId = streamId;
    pushDebugEvent(
      session,
      "Using the stream id created from the popup click gesture."
    );

    pushDebugEvent(session, "Stream id ready. Handing it to the offscreen recorder.");
    setPipeline(session, {
      captureStage: "arming",
      uploadStage: "idle",
      backendStage: "idle",
      detail: "Stream id received. Starting the offscreen recorder.",
      lastError: ""
    });
    setSession(tabId, session);
    await persistState();
    await pushSessionUpdate(tabId);

    const offscreenResponse = await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "OFFSCREEN_START_RECORDING",
      tabId,
      streamId: effectiveStreamId
    });

    if (!offscreenResponse?.ok) {
      throw new Error(offscreenResponse?.error || "Offscreen recorder did not acknowledge start.");
    }

    const runtime = getRuntime(tabId);
    runtime.streamActive = true;

    session.statusNote =
      "Sampling frames every 2.5 seconds. Local verdicts typically arrive within a few hundred ms per frame.";
    session.scanInProgress = true;
    session.awaitingFirstScan = true;
    setPipeline(session, {
      captureStage: "recording",
      uploadStage: "idle",
      backendStage: "model_ready",
      detail: "Tab capture is live. Running local deepfake inference each sample.",
      lastError: ""
    });
    pushDebugEvent(session, "Frame sampler acknowledged start.");
    setSession(tabId, session);
    await persistState();
    await pushSessionUpdate(tabId);
  } catch (error) {
    session.scanInProgress = false;
    session.errorCode = "capture_bootstrap_failed";
    session.errorMessage =
      "Capture failed before recording started. Check the service worker event log.";
    session.statusNote = session.errorMessage;
    setPipeline(session, {
      captureStage: "error",
      uploadStage: "idle",
      backendStage: "idle",
      detail: error?.message || "The capture bootstrap failed before frame sampling started.",
      lastError: session.errorMessage
    });
    pushDebugEvent(
      session,
      error?.message || "The capture bootstrap failed before frame sampling started.",
      "error"
    );
    setSession(tabId, session);
    await persistState();
    await pushSessionUpdate(tabId);
    throw error;
  }
}

async function endOtherActiveSessions(exceptTabId) {
  const activeTabIds = Object.entries(sessions)
    .filter(([tabId, session]) => Number(tabId) !== exceptTabId && session?.active)
    .map(([tabId]) => Number(tabId));

  for (const tabId of activeTabIds) {
    await endSession(tabId);
  }
}

async function startMonitoring({
  tabId,
  requestedDemoMode = false,
  streamId,
  source = "unknown"
}) {
  await ensureStateLoaded();
  const existingSession = sessionFor(tabId);

  if (existingSession?.active) {
    await endSession(tabId);
  }

  await endOtherActiveSessions(tabId);

  const tab = await chrome.tabs.get(tabId);
  if (!isSupportedUrl(tab?.url || "")) {
    throw new Error(
      "Open HireShield on Meet, Zoom, Teams, YouTube, or localhost:3000."
    );
  }

  const demoMode = requestedDemoMode || settings.demoMode || isDemoQueryEnabled(tab.url);

  const nextSession = defaultSession(tabId, demoMode);
  nextSession.active = true;
  nextSession.paused = false;
  nextSession.scanInProgress = demoMode ? true : false;
  nextSession.statusNote = demoMode
    ? "Scanning in demo mode. First verdict arrives in about 15 seconds."
    : "Preparing on-device deepfake inference (first run downloads ~50 MB).";
  setPipeline(nextSession, {
    captureStage: demoMode ? "demo" : "arming",
    uploadStage: demoMode ? "demo" : "idle",
    backendStage: demoMode ? "demo" : "loading_model",
    detail: demoMode
      ? "Demo timeline armed. First verdict arrives in about 15 seconds."
      : "Preparing on-device deepfake inference (first run downloads ~50 MB).",
    lastError: ""
  });
  pushDebugEvent(
    nextSession,
    demoMode
      ? `Demo monitoring started from ${source}.`
      : `Monitoring requested from ${source}.`
  );

  setSession(tabId, nextSession);
  await persistState();
  await ensureContentScript(tabId);
  await pushSessionUpdate(tabId);

  if (demoMode) {
    return publicSession(nextSession);
  }

  await startRealMonitoring({ tabId, streamId });
  return publicSession(sessionFor(tabId));
}

async function pauseMonitoring(tabId) {
  await ensureStateLoaded();
  const session = sessionFor(tabId);
  if (!session || !session.active || session.paused) {
    return publicSession(session);
  }

  const demoElapsed = session.demoMode ? currentDemoElapsedMs(session) : 0;
  session.paused = true;
  session.scanInProgress = false;
  session.statusNote = "Monitoring paused";
  setPipeline(session, {
    captureStage: "paused",
    uploadStage: session.demoMode ? "demo" : "idle",
    backendStage: session.demoMode ? "demo" : "model_ready",
    detail: "Monitoring is paused.",
    lastError: ""
  });
  pushDebugEvent(session, "Monitoring paused.", "warn");
  session.updatedAt = Date.now();

  if (session.demoMode) {
    session.demoProgress.elapsedBeforePauseMs = demoElapsed;
  } else {
    await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "OFFSCREEN_PAUSE_RECORDING",
      tabId
    });
  }

  setSession(tabId, session);
  await persistState();
  await pushSessionUpdate(tabId);
  return publicSession(session);
}

async function resumeMonitoring(tabId) {
  await ensureStateLoaded();
  const session = sessionFor(tabId);
  if (!session || !session.active || !session.paused) {
    return publicSession(session);
  }

  session.paused = false;
  session.updatedAt = Date.now();

  if (session.demoMode) {
    session.demoProgress.lastResumedAt = Date.now();
    session.statusNote = nextDemoDelayText(session);
    session.scanInProgress = session.demoProgress.stepIndex < DEMO_SCANS.length;
    setPipeline(session, {
      captureStage: "demo",
      uploadStage: "demo",
      backendStage: "demo",
      detail: nextDemoDelayText(session),
      lastError: ""
    });
  } else {
    session.statusNote = "Resumed. Sampling frames for local inference now.";
    session.scanInProgress = true;
    setPipeline(session, {
      captureStage: "recording",
      uploadStage: "idle",
      backendStage: "model_ready",
      detail: "Monitoring resumed. Local inference will score the next sampled frame.",
      lastError: ""
    });
    await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "OFFSCREEN_RESUME_RECORDING",
      tabId
    });
  }

  pushDebugEvent(session, "Monitoring resumed.");
  setSession(tabId, session);
  await persistState();
  await pushSessionUpdate(tabId);
  return publicSession(session);
}

async function endSession(tabId, { removeCompletely = false } = {}) {
  await ensureStateLoaded();
  const session = sessionFor(tabId);
  if (!session) {
    return null;
  }

  if (!session.demoMode) {
    await chrome.runtime
      .sendMessage({
        target: "offscreen",
        type: "OFFSCREEN_STOP_RECORDING",
        tabId
      })
      .catch(() => undefined);
  }

  clearRuntime(tabId);

  if (removeCompletely) {
    deleteSession(tabId);
  } else {
    session.active = false;
    session.paused = false;
    session.ended = true;
    session.scanInProgress = false;
    session.statusNote = "Session ended";
    setPipeline(session, {
      captureStage: "idle",
      uploadStage: "idle",
      backendStage: "idle",
      detail: "Session ended.",
      lastError: ""
    });
    pushDebugEvent(session, "Session ended.");
    session.endedAt = Date.now();
    session.updatedAt = Date.now();
    setSession(tabId, session);
  }

  await persistState();
  await maybeCloseOffscreen();

  if (!removeCompletely) {
    await pushSessionUpdate(tabId);
    return publicSession(sessionFor(tabId));
  }

  return null;
}

async function clearSessionHistory(tabId) {
  await ensureStateLoaded();
  const session = sessionFor(tabId);
  if (!session) {
    return null;
  }

  session.history = [];
  session.currentScan = null;
  session.debugTrail = [];
  session.errorMessage = "";
  session.errorCode = "";
  session.awaitingFirstScan = session.active ? true : session.awaitingFirstScan;
  session.clipsCaptured = 0;
  session.lastClipCapturedAt = null;
  session.statusNote = session.active
    ? "Recent scans cleared. Next verdict coming up."
    : "Recent scans cleared.";
  setPipeline(session, {
    captureStage: session.active && !session.paused ? "recording" : "idle",
    uploadStage: "idle",
    backendStage: session.active ? "model_ready" : "idle",
    detail: "Scan history cleared.",
    lastError: ""
  });
  session.updatedAt = Date.now();
  pushDebugEvent(session, "Recent scans cleared from sidebar.", "info");
  setSession(tabId, session);
  await persistState();
  await pushSessionUpdate(tabId);
  return publicSession(session);
}

async function resetLastScanForRefresh(tabId) {
  await ensureStateLoaded();
  const session = sessionFor(tabId);
  if (!session) {
    return null;
  }

  // A real page refresh kills the tab-capture MediaStream, so any active
  // session is effectively orphaned. Stop it and wipe the last scan; keep
  // the stored history so the user can still review earlier verdicts.
  if (session.active && !session.demoMode) {
    await chrome.runtime
      .sendMessage({
        target: "offscreen",
        type: "OFFSCREEN_STOP_RECORDING",
        tabId
      })
      .catch(() => undefined);
    clearRuntime(tabId);
  }

  session.active = false;
  session.paused = false;
  session.ended = true;
  session.scanInProgress = false;
  session.currentScan = null;
  session.errorMessage = "";
  session.errorCode = "";
  session.awaitingFirstScan = true;
  session.clipsCaptured = 0;
  session.lastClipCapturedAt = null;
  session.statusNote = "Page refreshed — last scan cleared.";
  setPipeline(session, {
    captureStage: "idle",
    uploadStage: "idle",
    backendStage: "idle",
    detail: "Page refreshed. Click Start monitoring to begin a fresh scan.",
    lastError: ""
  });
  pushDebugEvent(session, "Page refresh detected — ended session and cleared last scan.", "info");
  session.updatedAt = Date.now();
  setSession(tabId, session);
  await persistState();
  await maybeCloseOffscreen();
  await pushSessionUpdate(tabId);
  return publicSession(session);
}

async function getSessionState(tabId) {
  await ensureStateLoaded();
  await advanceDemoState(tabId);
  const session = sessionFor(tabId);

  if (
    session &&
    session.active &&
    !session.demoMode &&
    session.clipsCaptured === 0 &&
    !session.paused &&
    !session.errorMessage
  ) {
    const elapsedMs = Date.now() - session.startedAt;
    if (elapsedMs > 14000) {
      setPipeline(session, {
        captureStage: "paused",
        detail:
          "No frames analyzed yet. Check that the tab video is actively playing."
      });
      session.statusNote =
        "No frames analyzed yet. Confirm the video is playing and capture was allowed.";
      setSession(tabId, session);
      await persistState();
    }
  }

  return publicSession(sessionFor(tabId));
}

async function setDemoMode(enabled) {
  await ensureStateLoaded();
  settings.demoMode = Boolean(enabled);
  await persistState();
  return publicSettings();
}

function publicSettings() {
  return {
    demoMode: settings.demoMode,
    modelId: LOCAL_MODEL_ID,
    inferenceMode: "local_transformers"
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === "offscreen") {
    return false;
  }

  const respond = async () => {
    await ensureStateLoaded();

    switch (message?.type) {
      case "GET_CURRENT_TAB_CONTEXT":
        return {
          ok: true,
          tabId: sender.tab?.id || null,
          url: sender.tab?.url || ""
        };

      case "GET_SESSION_STATE":
        return {
          ok: true,
          state: await getSessionState(message.tabId)
        };

      case "POLL_DEMO_STATE":
        await advanceDemoState(message.tabId);
        return {
          ok: true,
          state: publicSession(sessionFor(message.tabId))
        };

      case "GET_SETTINGS":
        return {
          ok: true,
          settings: publicSettings()
        };

      case "SET_DEMO_MODE":
        return {
          ok: true,
          settings: await setDemoMode(message.enabled)
        };

      case "START_MONITORING":
        return {
          ok: true,
          state: await startMonitoring(message)
        };

      case "PAUSE_MONITORING":
        return {
          ok: true,
          state: await pauseMonitoring(message.tabId)
        };

      case "RESUME_MONITORING":
        return {
          ok: true,
          state: await resumeMonitoring(message.tabId)
        };

      case "END_SESSION":
        return {
          ok: true,
          state: await endSession(message.tabId, {
            removeCompletely: Boolean(message.removeCompletely)
          })
        };

      case "CLEAR_SESSION_HISTORY":
        return {
          ok: true,
          state: await clearSessionHistory(message.tabId)
        };

      case "PAGE_REFRESHED":
        return {
          ok: true,
          state: await resetLastScanForRefresh(message.tabId)
        };

      case "OFFSCREEN_CLASSIFIED":
        await handleClassifiedFrame(message.tabId, message);
        return { ok: true };

      case "OFFSCREEN_STATUS": {
        const session = handleOffscreenStatus(
          message.tabId,
          message.stage,
          message.detail
        );
        if (session) {
          await persistState();
          await pushSessionUpdate(message.tabId);
        }
        return { ok: true };
      }

      case "OFFSCREEN_RECORDING_ERROR": {
        const session = sessionFor(message.tabId);
        if (session) {
          const details = describeInferenceError(message.error || "");
          session.errorMessage = details.userMessage;
          session.errorCode = details.code;
          session.statusNote = details.userMessage;
          session.scanInProgress = false;
          setPipeline(session, {
            captureStage: "error",
            uploadStage: "idle",
            backendStage: "error",
            detail: details.detail,
            lastError: details.userMessage
          });
          pushDebugEvent(session, details.detail, "error");
          clearRuntime(message.tabId);
          session.updatedAt = Date.now();
          setSession(message.tabId, session);
          await persistState();
          await pushSessionUpdate(message.tabId);
        }
        return { ok: true };
      }

      case "OFFSCREEN_STREAM_ENDED": {
        const session = sessionFor(message.tabId);
        if (session?.active) {
          session.errorCode = "capture_stream_ended";
          session.errorMessage =
            "Chrome stopped tab capture unexpectedly. Start monitoring again.";
          session.statusNote = session.errorMessage;
          session.scanInProgress = false;
          setPipeline(session, {
            captureStage: "error",
            uploadStage: "idle",
            backendStage: "idle",
            detail: "The tab capture stream ended before the next clip could finish.",
            lastError: session.errorMessage
          });
          pushDebugEvent(
            session,
            "The tab capture stream ended unexpectedly.",
            "error"
          );
          clearRuntime(message.tabId);
          session.updatedAt = Date.now();
          setSession(message.tabId, session);
          await persistState();
          await pushSessionUpdate(message.tabId);
        }
        return { ok: true };
      }

      default:
        return { ok: false, error: "Unknown message type." };
    }
  };

  respond()
    .then((response) => sendResponse(response))
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error?.message || "HireShield request failed."
      });
    });

  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  endSession(tabId, { removeCompletely: true }).catch(() => undefined);
});
