const DEFAULTS = {
  dashboardUrl: "http://127.0.0.1:3020",
  dashboardToken: "",
  cdpUrl: "http://127.0.0.1:9222",
  promptOverride: "",
};

const ids = {
  dashboardUrl: document.getElementById("dashboardUrl"),
  dashboardToken: document.getElementById("dashboardToken"),
  cdpUrl: document.getElementById("cdpUrl"),
  promptOverride: document.getElementById("promptOverride"),
  saveSettings: document.getElementById("saveSettings"),
  openDashboard: document.getElementById("openDashboard"),
  checkRuntime: document.getElementById("checkRuntime"),
  checkCdp: document.getElementById("checkCdp"),
  saveMemory: document.getElementById("saveMemory"),
  sendPrompt: document.getElementById("sendPrompt"),
  status: document.getElementById("status"),
};

function normalizeBaseUrl(value, fallback) {
  const raw = String(value || "").trim();
  if (!raw) {
    return fallback;
  }
  return raw.replace(/\/+$/, "");
}

function nowIso() {
  return new Date().toISOString();
}

function setStatus(text, isError = false) {
  ids.status.style.borderColor = isError ? "#dc2626" : "#1f2937";
  ids.status.textContent = String(text || "").trim() || (isError ? "Error" : "OK");
}

function getHeaders(settings) {
  const headers = {
    "content-type": "application/json",
  };
  const token = String(settings.dashboardToken || "").trim();
  if (token) {
    headers["x-nxclaw-token"] = token;
  }
  return headers;
}

async function getSettings() {
  const loaded = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return {
    dashboardUrl: normalizeBaseUrl(loaded.dashboardUrl, DEFAULTS.dashboardUrl),
    dashboardToken: String(loaded.dashboardToken || ""),
    cdpUrl: normalizeBaseUrl(loaded.cdpUrl, DEFAULTS.cdpUrl),
    promptOverride: String(loaded.promptOverride || ""),
  };
}

async function saveSettings() {
  const next = {
    dashboardUrl: normalizeBaseUrl(ids.dashboardUrl.value, DEFAULTS.dashboardUrl),
    dashboardToken: String(ids.dashboardToken.value || ""),
    cdpUrl: normalizeBaseUrl(ids.cdpUrl.value, DEFAULTS.cdpUrl),
    promptOverride: String(ids.promptOverride.value || ""),
  };
  await chrome.storage.local.set(next);
  return next;
}

async function loadIntoForm() {
  const settings = await getSettings();
  ids.dashboardUrl.value = settings.dashboardUrl;
  ids.dashboardToken.value = settings.dashboardToken;
  ids.cdpUrl.value = settings.cdpUrl;
  ids.promptOverride.value = settings.promptOverride;
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab || !tab.url) {
    throw new Error("No active tab URL available.");
  }
  return tab;
}

async function apiRequest(settings, path, body = null, method = "POST") {
  const res = await fetch(`${settings.dashboardUrl}${path}`, {
    method,
    headers: getHeaders(settings),
    body: body ? JSON.stringify(body) : undefined,
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload.ok === false) {
    throw new Error(String(payload?.error || `HTTP ${res.status}`));
  }
  return payload;
}

async function onCheckRuntime() {
  const settings = await getSettings();
  const state = await apiRequest(settings, "/api/state", null, "GET");
  const summary = {
    ok: true,
    queueDepth: Number(state?.queueDepth || 0),
    objectives: Array.isArray(state?.objectives) ? state.objectives.length : 0,
    runningTasks: Array.isArray(state?.runningTasks) ? state.runningTasks.length : 0,
    model: state?.provider?.model || "",
  };
  setStatus(`Runtime OK\n${JSON.stringify(summary, null, 2)}`);
}

async function onCheckCdp() {
  const settings = await getSettings();
  const res = await fetch(`${settings.cdpUrl}/json/version`);
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`CDP HTTP ${res.status}`);
  }

  const summary = {
    browser: String(payload.Browser || ""),
    protocolVersion: String(payload.ProtocolVersion || ""),
    websocket: String(payload.webSocketDebuggerUrl || ""),
  };
  setStatus(`CDP OK\n${JSON.stringify(summary, null, 2)}`);
}

async function onSaveMemory() {
  const settings = await getSettings();
  const tab = await getActiveTab();
  const title = String(tab.title || "browser tab").slice(0, 120);
  const url = String(tab.url || "");
  const content = `Title: ${title}\nURL: ${url}\nCapturedAt: ${nowIso()}\nSource: nxclaw-helper`;

  const payload = await apiRequest(settings, "/api/memory/note", {
    title: `Active tab: ${title}`.slice(0, 160),
    content,
    tags: ["browser", "nxclaw-helper"],
  });

  setStatus(`Saved to memory\nnoteId=${payload?.note?.id || "(unknown)"}\nurl=${url}`);
}

async function onSendPrompt() {
  const settings = await getSettings();
  const tab = await getActiveTab();
  const title = String(tab.title || "").trim();
  const url = String(tab.url || "").trim();
  const override = String(settings.promptOverride || "").trim();
  const message =
    override ||
    [
      "Use browser automation on this tab context and continue the task.",
      `Tab title: ${title}`,
      `Tab url: ${url}`,
      "Return concise progress and next action.",
    ].join("\n");

  const payload = await apiRequest(settings, "/api/prompt", {
    message,
  });

  const reply = String(payload?.reply || "").slice(0, 1200);
  setStatus(`Prompt sent\n${reply}`);
}

async function main() {
  await loadIntoForm();

  ids.saveSettings.addEventListener("click", async () => {
    try {
      const saved = await saveSettings();
      setStatus(`Saved\n${JSON.stringify(saved, null, 2)}`);
    } catch (error) {
      setStatus(String(error?.message || error), true);
    }
  });

  ids.openDashboard.addEventListener("click", async () => {
    try {
      const settings = await getSettings();
      await chrome.tabs.create({ url: settings.dashboardUrl });
      setStatus(`Opened ${settings.dashboardUrl}`);
    } catch (error) {
      setStatus(String(error?.message || error), true);
    }
  });

  ids.checkRuntime.addEventListener("click", async () => {
    try {
      await onCheckRuntime();
    } catch (error) {
      setStatus(`Runtime check failed\n${String(error?.message || error)}`, true);
    }
  });

  ids.checkCdp.addEventListener("click", async () => {
    try {
      await onCheckCdp();
    } catch (error) {
      setStatus(`CDP check failed\n${String(error?.message || error)}`, true);
    }
  });

  ids.saveMemory.addEventListener("click", async () => {
    try {
      await onSaveMemory();
    } catch (error) {
      setStatus(`Memory save failed\n${String(error?.message || error)}`, true);
    }
  });

  ids.sendPrompt.addEventListener("click", async () => {
    try {
      await onSendPrompt();
    } catch (error) {
      setStatus(`Prompt send failed\n${String(error?.message || error)}`, true);
    }
  });
}

main().catch((error) => {
  setStatus(String(error?.message || error), true);
});
