(() => {
  if (window.__hireshieldContentBooted) {
    return;
  }

  window.__hireshieldContentBooted = true;

  const HOST_ID = "hireshield-extension-host";
  const IFRAME_ID = "hireshield-extension-sidebar";
  const SIDEBAR_SRC_BASE = chrome.runtime.getURL("sidebar.html");
  const EXPANDED_WIDTH = "356px";
  const COLLAPSED_WIDTH = "52px";
  const MAINTAIN_INTERVAL_MS = 1500;

  let tabId = null;
  let iframe = null;
  let host = null;
  let iframeReady = false;
  let collapsed = false;
  let queuedMessages = [];
  let maintainTimer = null;

  function sidebarWidth() {
    return collapsed ? COLLAPSED_WIDTH : EXPANDED_WIDTH;
  }

  function buildSidebarUrl() {
    const params = new URLSearchParams({
      tabId: String(tabId || ""),
      page: location.hostname
    });
    return `${SIDEBAR_SRC_BASE}?${params.toString()}`;
  }

  function fullscreenRoot() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }

  function mountRoot() {
    return fullscreenRoot() || document.body || document.documentElement;
  }

  function syncLayout() {
    const width = sidebarWidth();

    if (host) {
      host.style.position = "fixed";
      host.style.top = "0";
      host.style.right = "0";
      host.style.bottom = "0";
      host.style.left = "auto";
      host.style.width = width;
      host.style.height = "100vh";
      host.style.zIndex = "2147483647";
      host.style.pointerEvents = "none";
      host.style.background = "transparent";
      host.style.overflow = "visible";
      host.style.display = "flex";
      host.style.alignItems = "stretch";
      host.style.justifyContent = "flex-end";
      host.style.margin = "0";
      host.style.padding = "0";
    }

    if (iframe) {
      iframe.style.width = width;
      iframe.style.height = "100vh";
      iframe.style.border = "0";
      iframe.style.background = "transparent";
      iframe.style.pointerEvents = "auto";
      iframe.style.overflow = "visible";
      iframe.style.colorScheme = "dark";
      iframe.style.display = "block";
      iframe.style.flex = "0 0 auto";
    }
  }

  function ensureHost() {
    if (!host || !document.contains(host)) {
      host = document.getElementById(HOST_ID) || document.createElement("div");
      host.id = HOST_ID;
    }

    const root = mountRoot();
    if (root && host.parentNode !== root) {
      root.appendChild(host);
    }

    syncLayout();
  }

  function ensureIframe() {
    if (!host) {
      return;
    }

    if (!iframe || !host.contains(iframe)) {
      iframe = host.querySelector(`#${IFRAME_ID}`) || document.createElement("iframe");
      iframe.id = IFRAME_ID;
      iframe.src = buildSidebarUrl();
      iframe.title = "HireShield Sidebar";
      iframe.setAttribute("allowtransparency", "true");
      iframeReady = false;
      iframe.addEventListener("load", () => {
        iframeReady = true;
        flushQueue();
      });
      host.appendChild(iframe);
    }

    syncLayout();
  }

  function ensureSidebar() {
    ensureHost();
    ensureIframe();
  }

  function postToSidebar(message) {
    if (!iframe?.contentWindow || !iframeReady) {
      queuedMessages.push(message);
      return;
    }

    iframe.contentWindow.postMessage(message, "*");
  }

  function flushQueue() {
    if (!iframeReady || !iframe?.contentWindow) {
      return;
    }

    for (const message of queuedMessages) {
      iframe.contentWindow.postMessage(message, "*");
    }

    queuedMessages = [];
  }

  async function requestInitialState() {
    if (!tabId) {
      return;
    }

    const response = await chrome.runtime.sendMessage({
      type: "GET_SESSION_STATE",
      tabId
    });

    if (response?.ok && response.state) {
      ensureSidebar();
      postToSidebar({
        type: "HIRESHIELD_SESSION_UPDATE",
        state: response.state
      });
    }
  }

  function startMaintainLoop() {
    if (maintainTimer) {
      return;
    }

    maintainTimer = window.setInterval(() => {
      ensureSidebar();
    }, MAINTAIN_INTERVAL_MS);
  }

  function stopMaintainLoop() {
    if (!maintainTimer) {
      return;
    }

    window.clearInterval(maintainTimer);
    maintainTimer = null;
  }

  async function init() {
    const context = await chrome.runtime.sendMessage({
      type: "GET_CURRENT_TAB_CONTEXT"
    });

    tabId = context?.tabId || null;

    // A fresh content-script boot always means a real page load (our
    // __hireshieldContentBooted guard prevents re-runs otherwise). Tell the
    // background to drop the last scan for this tab so the sidebar never
    // shows stale verdicts from a previous page.
    if (tabId) {
      await chrome.runtime
        .sendMessage({ type: "PAGE_REFRESHED", tabId })
        .catch(() => undefined);
    }

    ensureSidebar();
    await requestInitialState();
    startMaintainLoop();

    const lifecycleEvents = [
      "fullscreenchange",
      "webkitfullscreenchange",
      "resize",
      "orientationchange",
      "pageshow",
      "popstate",
      "hashchange",
      "yt-navigate-finish"
    ];

    for (const eventName of lifecycleEvents) {
      window.addEventListener(eventName, ensureSidebar, true);
      document.addEventListener(eventName, ensureSidebar, true);
    }

    document.addEventListener(
      "visibilitychange",
      () => {
        if (!document.hidden) {
          ensureSidebar();
        }
      },
      true
    );

    window.addEventListener(
      "beforeunload",
      () => {
        stopMaintainLoop();
      },
      { once: true }
    );
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "HIRESHIELD_SESSION_UPDATE") {
      ensureSidebar();
      postToSidebar(message);
      sendResponse({ ok: true });
      return true;
    }

    return false;
  });

  window.addEventListener("message", (event) => {
    if (event.source !== iframe?.contentWindow) {
      return;
    }

    if (event.data?.type === "HIRESHIELD_IFRAME_READY") {
      iframeReady = true;
      collapsed = Boolean(event.data.collapsed);
      syncLayout();
      flushQueue();
      return;
    }

    if (event.data?.type === "HIRESHIELD_COLLAPSE_STATE") {
      collapsed = Boolean(event.data.collapsed);
      syncLayout();
    }
  });

  init().catch(() => undefined);
})();
