const dashboardUrl = "http://localhost:3000";

const elements = {
  statusPill: document.getElementById("statusPill"),
  statusLabel: document.getElementById("statusLabel"),
  platformLabel: document.getElementById("platformLabel"),
  headline: document.getElementById("headline"),
  summary: document.getElementById("summary"),
  sessionStatus: document.getElementById("sessionStatus"),
  scanTarget: document.getElementById("scanTarget"),
  modeSummary: document.getElementById("modeSummary"),
  primaryButton: document.getElementById("primaryButton"),
  demoToggle: document.getElementById("demoToggle"),
  openDashboard: document.getElementById("openDashboard"),
  popupNote: document.getElementById("popupNote")
};

let activeTab = null;
let currentSession = null;
let settings = {
  demoMode: false,
  modelId: "onnx-community/Deep-Fake-Detector-v2-Model-ONNX",
  inferenceMode: "local_transformers"
};

function supportedUrl(url = "") {
  return (
    url.startsWith("https://meet.google.com/") ||
    /^https:\/\/[A-Za-z0-9.-]+\.zoom\.us\//.test(url) ||
    url.startsWith("https://teams.microsoft.com/") ||
    url.startsWith("https://www.youtube.com/") ||
    url.startsWith("https://youtube.com/") ||
    url.startsWith("http://localhost:3000/")
  );
}

function platformFromUrl(url = "") {
  if (url.startsWith("https://meet.google.com/")) {
    return "Google Meet";
  }
  if (/^https:\/\/[A-Za-z0-9.-]+\.zoom\.us\//.test(url)) {
    return "Zoom";
  }
  if (url.startsWith("https://teams.microsoft.com/")) {
    return "Microsoft Teams";
  }
  if (url.startsWith("https://www.youtube.com/") || url.startsWith("https://youtube.com/")) {
    return "YouTube";
  }
  if (url.startsWith("http://localhost:3000/")) {
    return "Local demo dashboard";
  }
  return "Unsupported page";
}

function isQueryDemo(url = "") {
  try {
    const params = new URL(url).searchParams;
    const value = (
      params.get("hireshieldDemo") ||
      params.get("demoMode") ||
      params.get("demo") ||
      ""
    ).toLowerCase();
    return ["1", "true", "yes", "on"].includes(value);
  } catch (error) {
    return false;
  }
}

function updateStatusPill(state) {
  elements.statusPill.className = "popup-status-pill";

  if (!state) {
    elements.statusLabel.textContent = "Ready";
    return;
  }

  if (state.ended) {
    elements.statusPill.classList.add("is-ended");
    elements.statusLabel.textContent = "Ended";
    return;
  }

  if (state.active && state.paused) {
    elements.statusPill.classList.add("is-paused");
    elements.statusLabel.textContent = "Paused";
    return;
  }

  if (state.active) {
    elements.statusPill.classList.add("is-active");
    elements.statusLabel.textContent = "Monitoring";
    return;
  }

  elements.statusLabel.textContent = "Ready";
}

function render() {
  const supported = supportedUrl(activeTab?.url || "");
  const forcedDemo = isQueryDemo(activeTab?.url || "");
  const effectiveDemo = forcedDemo || settings.demoMode;

  elements.platformLabel.textContent = platformFromUrl(activeTab?.url || "");
  elements.demoToggle.checked = settings.demoMode;
  elements.modeSummary.textContent = effectiveDemo ? "Demo mode" : "Local inference";
  elements.scanTarget.textContent = effectiveDemo
    ? "Local staged demo responses"
    : "On-device (Transformers.js)";

  updateStatusPill(currentSession);

  if (!supported) {
    elements.primaryButton.textContent = "Open a supported page";
    elements.primaryButton.disabled = true;
    elements.sessionStatus.textContent = "Unavailable";
    elements.headline.textContent = "Point HireShield at the call page first";
    elements.summary.textContent =
      "Open Google Meet, Zoom, Teams, YouTube, or the local demo page before starting monitoring.";
    elements.popupNote.textContent =
      "This popup only activates on meet.google.com, *.zoom.us, teams.microsoft.com, youtube.com, or localhost:3000.";
    return;
  }

  elements.primaryButton.disabled = false;

  if (effectiveDemo) {
    elements.popupNote.textContent = forcedDemo
      ? "Demo mode is forced by the current page URL query param."
      : "Demo mode replays staged verdicts. Turn it off to run the on-device model.";
  } else {
    elements.popupNote.textContent =
      "First live run downloads the model once, then every scan runs locally on this device. No frame data leaves the browser.";
  }

  if (currentSession?.active) {
    elements.primaryButton.textContent = "Stop Monitoring";
    elements.sessionStatus.textContent = currentSession.paused ? "Paused" : "Active";
    elements.headline.textContent = currentSession.demoMode
      ? "Demo sequence is live in the sidebar"
      : "Live on-device scanning is running on this tab";
    elements.summary.textContent = currentSession.errorMessage || currentSession.statusNote || "HireShield is monitoring the active interview.";
    return;
  }

  if (currentSession?.ended) {
    elements.primaryButton.textContent = "Start Monitoring";
    elements.sessionStatus.textContent = "Ended";
    elements.headline.textContent = "Session complete";
    elements.summary.textContent = "You can start a fresh monitoring session with one click.";
    return;
  }

  elements.primaryButton.textContent = "Start Monitoring";
  elements.sessionStatus.textContent = "Inactive";
  elements.headline.textContent = "Stage-ready interview verification";
  elements.summary.textContent = effectiveDemo
    ? "The sidebar will show staged verdicts after realistic delays without running the model."
    : "One click starts secure tab capture and runs the deepfake model locally on every sampled frame.";
}

async function loadContext() {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  activeTab = tab || null;

  const settingsResponse = await chrome.runtime.sendMessage({
    type: "GET_SETTINGS"
  });
  if (settingsResponse?.ok) {
    settings = { ...settings, ...settingsResponse.settings };
  }

  if (activeTab?.id) {
    const stateResponse = await chrome.runtime.sendMessage({
      type: "GET_SESSION_STATE",
      tabId: activeTab.id
    });
    if (stateResponse?.ok) {
      currentSession = stateResponse.state;
    }
  }

  render();
}

async function startMonitoring() {
  const forcedDemo = isQueryDemo(activeTab?.url || "");
  const requestedDemoMode = forcedDemo || elements.demoToggle.checked;
  let streamId = null;

  if (!requestedDemoMode) {
    try {
      streamId = await chrome.tabCapture.getMediaStreamId({
        targetTabId: activeTab.id
      });
      if (!streamId) {
        throw new Error("Chrome returned an empty stream id.");
      }
    } catch (error) {
      elements.popupNote.textContent = `${error?.message || "Chrome blocked tab capture."} Make sure the target tab is the active tab in this window, then click Start Monitoring again.`;
      return;
    }
  }

  const response = await chrome.runtime.sendMessage({
    type: "START_MONITORING",
    tabId: activeTab.id,
    streamId,
    requestedDemoMode,
    source: "popup"
  });

  if (!response?.ok) {
    elements.popupNote.textContent = response?.error || "Could not start monitoring.";
    return;
  }

  currentSession = response.state;
  render();
}

async function stopMonitoring() {
  const response = await chrome.runtime.sendMessage({
    type: "END_SESSION",
    tabId: activeTab.id
  });

  if (response?.ok) {
    currentSession = response.state;
    render();
  }
}

elements.primaryButton.addEventListener("click", async () => {
  if (!activeTab?.id) {
    return;
  }

  if (currentSession?.active) {
    await stopMonitoring();
    return;
  }

  await startMonitoring();
});

elements.demoToggle.addEventListener("change", async (event) => {
  const response = await chrome.runtime.sendMessage({
    type: "SET_DEMO_MODE",
    enabled: event.target.checked
  });

  if (response?.ok) {
    settings = { ...settings, ...response.settings };
    render();
  }
});

elements.openDashboard.addEventListener("click", async () => {
  await chrome.tabs.create({ url: dashboardUrl });
});

loadContext().catch(() => {
  elements.popupNote.textContent = "HireShield could not read the current tab context.";
});
