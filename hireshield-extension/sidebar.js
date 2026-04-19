const tabId = Number(new URLSearchParams(window.location.search).get("tabId"));
const ringLength = 402;
const animationDuration = 600;
const ACTIVITY_STORAGE_KEY = "hireshieldSidebarActivityExpanded";

const elements = {
  shell: document.getElementById("shell"),
  toggleCollapse: document.getElementById("toggleCollapse"),
  statusPill: document.getElementById("statusPill"),
  statusLabel: document.getElementById("statusLabel"),
  scoreValue: document.getElementById("scoreValue"),
  scoreCaption: document.getElementById("scoreCaption"),
  scoreRing: document.getElementById("scoreRing"),
  verdictText: document.getElementById("verdictText"),
  verdictSubtext: document.getElementById("verdictSubtext"),
  lastUpdated: document.getElementById("lastUpdated"),
  modeLabel: document.getElementById("modeLabel"),
  captureDot: document.getElementById("captureDot"),
  uploadDot: document.getElementById("uploadDot"),
  backendDot: document.getElementById("backendDot"),
  captureStageText: document.getElementById("captureStageText"),
  uploadStageText: document.getElementById("uploadStageText"),
  backendStageText: document.getElementById("backendStageText"),
  pipelineDetail: document.getElementById("pipelineDetail"),
  debugCount: document.getElementById("debugCount"),
  debugList: document.getElementById("debugList"),
  historyCount: document.getElementById("historyCount"),
  historyList: document.getElementById("historyList"),
  primaryAction: document.getElementById("primaryAction"),
  endSession: document.getElementById("endSession"),
  errorBanner: document.getElementById("errorBanner"),
  resetHistory: document.getElementById("resetHistory"),
  activityToggle: document.getElementById("activityToggle"),
  activityBody: document.getElementById("activityBody"),
  activitySummary: document.getElementById("activitySummary")
};

let currentState = null;
let displayedScore = 0;
let animationFrame = null;
let syncInterval = null;
let userSettings = { demoMode: false };
let activityExpanded = false;

async function loadSettings() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
    if (response?.ok && response.settings) {
      userSettings = response.settings;
    }
  } catch (error) {
    // Sidebar can render with defaults if settings fetch fails.
  }
}

function easeOutCubic(progress) {
  return 1 - Math.pow(1 - progress, 3);
}

function toneForState(state) {
  if (state?.currentScan?.noFaceDetected) return "neutral";
  if (state?.tone) return state.tone;
  return "neutral";
}

function colorForTone(tone) {
  switch (tone) {
    case "positive": return "#54C07A";
    case "caution":  return "#F5A623";
    case "danger":   return "#E5484D";
    default:         return "#C9A961";
  }
}

function formatRelativeTime(timestamp) {
  if (!timestamp) return "No scans yet";
  return `Updated ${new Date(timestamp).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit"
  })}`;
}

function stopAnimation() {
  if (animationFrame) {
    cancelAnimationFrame(animationFrame);
    animationFrame = null;
  }
}

function updateRing(score, tone) {
  const safeScore = typeof score === "number" ? Math.max(0, Math.min(100, score)) : 0;
  const dashOffset = ringLength - (safeScore / 100) * ringLength;
  elements.scoreRing.style.strokeDashoffset = String(dashOffset);
  elements.scoreRing.style.stroke = colorForTone(tone);
  document.documentElement.style.setProperty("--hs-score-color", colorForTone(tone));
}

function animateScore(targetScore, tone) {
  stopAnimation();
  const startScore = displayedScore;
  const startedAt = performance.now();

  const tick = (timestamp) => {
    const progress = Math.min(1, (timestamp - startedAt) / animationDuration);
    displayedScore = startScore + (targetScore - startScore) * easeOutCubic(progress);
    const rounded = Math.round(displayedScore);
    elements.scoreValue.textContent = String(rounded);
    updateRing(displayedScore, tone);

    if (progress < 1) {
      animationFrame = requestAnimationFrame(tick);
    } else {
      displayedScore = targetScore;
      animationFrame = null;
    }
  };

  animationFrame = requestAnimationFrame(tick);
}

function renderStatus(state) {
  const { statusPill, statusLabel } = elements;
  statusPill.className = "hs-status-pill";

  if (!state) {
    statusPill.classList.add("is-idle");
    statusLabel.textContent = "Idle";
    return;
  }

  if (state.ended) {
    statusPill.classList.add("is-ended");
    statusLabel.textContent = "Ended";
    return;
  }

  if (state.active && state.paused) {
    statusPill.classList.add("is-paused");
    statusLabel.textContent = "Paused";
    return;
  }

  if (state.active) {
    statusPill.classList.add("is-monitoring");
    statusLabel.textContent = "Monitoring";
    return;
  }

  statusPill.classList.add("is-idle");
  statusLabel.textContent = "Idle";
}

function renderScore(state) {
  const scan = state?.currentScan;
  const tone = toneForState(state);

  if (!scan) {
    stopAnimation();
    displayedScore = 0;
    elements.scoreValue.textContent = "--";
    elements.scoreCaption.textContent = state?.active ? "Scanning…" : "Awaiting first scan";
    updateRing(0, tone);
    return;
  }

  if (scan.noFaceDetected) {
    stopAnimation();
    displayedScore = 0;
    elements.scoreValue.textContent = "N/A";
    elements.scoreCaption.textContent = "No face detected";
    updateRing(18, "neutral");
    return;
  }

  elements.scoreCaption.textContent = "Trust score";
  animateScore(scan.trustScore || 0, tone);
}

function renderHistory(state) {
  const history = state?.history || [];
  elements.historyCount.textContent = `${history.length} / 5`;
  elements.resetHistory.disabled = history.length === 0 && !state?.currentScan;

  if (!history.length) {
    elements.historyList.innerHTML = state?.active
      ? `<div class="hs-empty">Sampling frames — first verdict incoming…</div>`
      : `<div class="hs-empty">No completed scans yet.</div>`;
    return;
  }

  elements.historyList.innerHTML = history
    .slice()
    .reverse()
    .map((scan) => {
      const tone = scan.noFaceDetected
        ? "neutral"
        : scan.verdict === "likely_authentic"
          ? "positive"
          : scan.verdict === "likely_deepfake"
            ? "danger"
            : "caution";

      const scoreMarkup = scan.noFaceDetected
        ? `<span class="hs-history-score is-muted">No face</span>`
        : `<span class="hs-history-score">${scan.trustScore}%</span>`;

      const fillClass = scan.noFaceDetected ? "is-empty" : `is-${tone}`;
      const width = scan.noFaceDetected ? 100 : scan.trustScore;

      return `
        <div class="hs-history-item">
          <div class="hs-history-topline">
            <span class="hs-history-time">${new Date(scan.receivedAt).toLocaleTimeString([], {
              hour: "numeric",
              minute: "2-digit"
            })}</span>
            ${scoreMarkup}
          </div>
          <div class="hs-history-bar">
            <div class="hs-history-fill ${fillClass}" style="width: ${width}%"></div>
          </div>
        </div>
      `;
    })
    .join("");
}

function renderMeta(state) {
  if (state?.currentScan) {
    elements.lastUpdated.textContent = formatRelativeTime(state.currentScan.receivedAt);
  } else if (state?.active && state?.clipsCaptured > 0) {
    elements.lastUpdated.textContent =
      state.clipsCaptured === 1
        ? "1 frame sampled"
        : `${state.clipsCaptured} frames sampled`;
  } else if (state?.active) {
    elements.lastUpdated.textContent = "Scanning now";
  } else {
    elements.lastUpdated.textContent = "No scans yet";
  }

  elements.modeLabel.textContent = state?.demoMode ? "Demo mode" : "Local inference";
}

function pipelineForState(state) {
  return (
    state?.pipeline || {
      captureStage: "idle",
      uploadStage: "idle",
      backendStage: "idle",
      detail: "Waiting to start."
    }
  );
}

function setStageDot(element, tone) {
  element.className = "hs-stage-dot";
  element.classList.add(`is-${tone}`);
}

function toneForStage(stage) {
  switch (stage) {
    case "recording":
    case "arming":
    case "posting":
    case "waiting":
    case "loading_model":
    case "demo":
      return "live";
    case "model_ready":
    case "clip_ready":
    case "complete":
    case "responded":
      return "ok";
    case "paused":
    case "queued":
      return "warn";
    case "error":
      return "error";
    default:
      return "idle";
  }
}

function captureStageLabel(stage) {
  switch (stage) {
    case "arming":     return "Preparing secure tab capture";
    case "recording":  return "Sampling frames every 2.5s";
    case "clip_ready": return "Frame captured";
    case "paused":     return "Capture paused";
    case "error":      return "Capture failed";
    case "demo":       return "Demo timeline active";
    default:           return "Waiting to start";
  }
}

function uploadStageLabel(stage) {
  switch (stage) {
    case "posting":   return "Processing frame";
    case "queued":    return "Queued behind previous scan";
    case "complete":  return "Last frame scored";
    case "error":     return "Frame analysis failed";
    case "demo":      return "Simulated frame path";
    default:          return "Waiting for capture";
  }
}

function backendStageLabel(stage) {
  switch (stage) {
    case "loading_model": return "Downloading model weights…";
    case "model_ready":   return "Model loaded and ready";
    case "waiting":       return "Inference in progress";
    case "responded":     return "Verdict received";
    case "error":         return "Inference failed";
    case "demo":          return "Simulated verdict";
    default:              return "Not loaded";
  }
}

function renderActivity(state) {
  const pipeline = pipelineForState(state);

  const summary = state?.errorMessage
    ? "Attention"
    : pipeline.backendStage === "loading_model"
      ? "Loading model"
      : pipeline.captureStage === "recording" && !state?.currentScan
        ? "Scanning"
        : state?.ended
          ? "Ended"
          : state?.active
            ? state.paused ? "Paused" : "Live"
            : "Idle";
  elements.activitySummary.textContent = summary;

  setStageDot(elements.captureDot, toneForStage(pipeline.captureStage));
  setStageDot(elements.uploadDot, toneForStage(pipeline.uploadStage));
  setStageDot(elements.backendDot, toneForStage(pipeline.backendStage));

  elements.captureStageText.textContent = captureStageLabel(pipeline.captureStage);
  elements.uploadStageText.textContent = uploadStageLabel(pipeline.uploadStage);
  elements.backendStageText.textContent = backendStageLabel(pipeline.backendStage);
  elements.pipelineDetail.textContent =
    pipeline.detail || state?.statusNote || "Waiting to start.";

  const trail = state?.debugTrail || [];
  elements.debugCount.textContent = String(trail.length);

  if (!trail.length) {
    elements.debugList.innerHTML = `<div class="hs-empty">No runtime events yet.</div>`;
    return;
  }

  elements.debugList.innerHTML = trail
    .slice()
    .reverse()
    .map((entry) => {
      const levelClass =
        entry.level === "error" ? "is-error" : entry.level === "warn" ? "is-warn" : "";

      return `
        <div class="hs-debug-item ${levelClass}">
          <span class="hs-debug-time">${new Date(entry.timestamp).toLocaleTimeString([], {
            hour: "numeric",
            minute: "2-digit",
            second: "2-digit"
          })}</span>
          <div class="hs-debug-text">${entry.message}</div>
        </div>
      `;
    })
    .join("");
}

function setActivityExpanded(expanded, { persist = true } = {}) {
  activityExpanded = expanded;
  elements.activityToggle.setAttribute("aria-expanded", String(expanded));
  elements.activityBody.hidden = !expanded;

  if (persist) {
    window.localStorage.setItem(ACTIVITY_STORAGE_KEY, expanded ? "1" : "0");
  }
}

function syncActivityExpansion(state) {
  const shouldForceOpen =
    Boolean(state?.errorMessage) ||
    (Boolean(state?.active) &&
      (!state?.currentScan || state?.pipeline?.backendStage === "loading_model"));

  if (shouldForceOpen && !activityExpanded) {
    setActivityExpanded(true, { persist: false });
  }
}

function renderCopy(state) {
  elements.verdictText.textContent = state?.verdictTitle || "Ready when you are";
  elements.verdictSubtext.textContent =
    state?.errorMessage ||
    state?.statusNote ||
    state?.verdictSubtitle ||
    "Start monitoring to run deepfake analysis on this tab.";
}

function renderButtons(state) {
  if (!state || state.ended || !state.active) {
    const demoMode = state?.demoMode ?? userSettings.demoMode;
    if (demoMode) {
      elements.primaryAction.textContent = "Start demo monitoring";
      elements.primaryAction.dataset.action = "start_demo";
    } else {
      elements.primaryAction.textContent = "Open popup to start";
      elements.primaryAction.dataset.action = "start_from_popup";
    }
  } else if (state.paused) {
    elements.primaryAction.textContent = "Resume monitoring";
    elements.primaryAction.dataset.action = "resume";
  } else {
    elements.primaryAction.textContent = "Pause monitoring";
    elements.primaryAction.dataset.action = "pause";
  }

  elements.endSession.disabled = !state || (!state.active && !state.ended && !(state.history || []).length);
}

function renderError(state) {
  if (state?.errorMessage) {
    elements.errorBanner.classList.remove("hidden");
    elements.errorBanner.textContent = state.errorMessage;
    return;
  }

  elements.errorBanner.classList.add("hidden");
  elements.errorBanner.textContent = "";
}

function render(state) {
  currentState = state;
  renderStatus(state);
  renderCopy(state);
  renderMeta(state);
  renderActivity(state);
  renderScore(state);
  renderHistory(state);
  renderButtons(state);
  renderError(state);
  syncActivityExpansion(state);
  syncLoop(state);
}

async function syncState(messageType = "GET_SESSION_STATE") {
  if (!tabId) return;

  const response = await chrome.runtime.sendMessage({ type: messageType, tabId });
  if (response?.ok) {
    render(response.state || null);
  }
}

function syncLoop(state) {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }

  if (!state?.active || state.ended) return;

  const cadence = state.demoMode ? 1000 : 3000;
  const messageType = state.demoMode ? "POLL_DEMO_STATE" : "GET_SESSION_STATE";

  syncInterval = setInterval(() => {
    syncState(messageType).catch(() => undefined);
  }, cadence);
}

async function performPrimaryAction() {
  const action = elements.primaryAction.dataset.action;

  if (action === "start_from_popup") {
    const guidance =
      "Click the HireShield icon in your browser toolbar, then press Start Monitoring. Chrome requires that click for live tab capture.";
    try {
      if (chrome.action?.openPopup) {
        await chrome.action.openPopup();
        return;
      }
    } catch (error) {
      // Fall through to user instruction.
    }
    render({
      ...(currentState || {}),
      errorMessage: guidance,
      statusNote: guidance
    });
    return;
  }

  if (action === "start_demo") {
    await chrome.runtime.sendMessage({
      type: "START_MONITORING",
      tabId,
      requestedDemoMode: true,
      source: "sidebar"
    });
    await syncState();
    return;
  }

  if (action === "pause") {
    await chrome.runtime.sendMessage({ type: "PAUSE_MONITORING", tabId });
    await syncState();
    return;
  }

  if (action === "resume") {
    await chrome.runtime.sendMessage({ type: "RESUME_MONITORING", tabId });
    await syncState();
    return;
  }
}

async function endCurrentSession() {
  await chrome.runtime.sendMessage({ type: "END_SESSION", tabId });
  await syncState();
}

async function resetHistory() {
  if (!tabId) return;
  elements.resetHistory.disabled = true;
  try {
    await chrome.runtime.sendMessage({ type: "CLEAR_SESSION_HISTORY", tabId });
    await syncState();
  } catch (error) {
    // re-enable on error; syncState will also refresh disabled state on success.
    elements.resetHistory.disabled = false;
  }
}

function bootCollapseState() {
  const collapsed = window.localStorage.getItem("hireshieldSidebarCollapsed") === "1";
  activityExpanded = window.localStorage.getItem(ACTIVITY_STORAGE_KEY) === "1";
  elements.shell.classList.toggle("is-collapsed", collapsed);
  setActivityExpanded(activityExpanded, { persist: false });
  window.parent.postMessage(
    { type: "HIRESHIELD_COLLAPSE_STATE", collapsed },
    "*"
  );
}

elements.toggleCollapse.addEventListener("click", () => {
  elements.shell.classList.toggle("is-collapsed");
  const collapsed = elements.shell.classList.contains("is-collapsed");
  window.localStorage.setItem("hireshieldSidebarCollapsed", collapsed ? "1" : "0");
  window.parent.postMessage(
    { type: "HIRESHIELD_COLLAPSE_STATE", collapsed },
    "*"
  );
});

elements.primaryAction.addEventListener("click", () => {
  performPrimaryAction().catch(() => undefined);
});

elements.endSession.addEventListener("click", () => {
  endCurrentSession().catch(() => undefined);
});

elements.resetHistory.addEventListener("click", () => {
  resetHistory().catch(() => undefined);
});

elements.activityToggle.addEventListener("click", () => {
  setActivityExpanded(!activityExpanded);
});

window.addEventListener("message", (event) => {
  if (event.data?.type === "HIRESHIELD_SESSION_UPDATE") {
    render(event.data.state || null);
  }
});

bootCollapseState();
window.parent.postMessage(
  {
    type: "HIRESHIELD_IFRAME_READY",
    collapsed: elements.shell.classList.contains("is-collapsed")
  },
  "*"
);

(async () => {
  await loadSettings();
  await syncState();
  if (!currentState) {
    render(null);
  }
})().catch(() => render(null));
