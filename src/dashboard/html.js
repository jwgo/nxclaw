export function dashboardHtml() {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>nxclaw web console</title>
    <style>
      :root {
        --bg: #0f162f;
        --panel: #172246;
        --line: #2f447f;
        --text: #ebf1ff;
        --muted: #9db2e8;
        --good: #35d399;
        --bad: #fb7185;
        --warn: #fbbf24;
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        color: var(--text);
        font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
        background:
          radial-gradient(circle at 10% -10%, #25386e 0%, transparent 45%),
          radial-gradient(circle at 85% 5%, #253054 0%, transparent 38%),
          var(--bg);
      }
      .wrap {
        max-width: 1280px;
        margin: 0 auto;
        padding: 20px;
      }
      h1 {
        margin: 0 0 12px;
        letter-spacing: 0.02em;
      }
      .sub {
        color: var(--muted);
        margin-bottom: 16px;
      }
      .grid {
        display: grid;
        gap: 12px;
        grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
      }
      .panel {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 12px;
        margin-top: 12px;
      }
      .label {
        color: var(--muted);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .value {
        margin-top: 6px;
        word-break: break-word;
      }
      .ok {
        color: var(--good);
      }
      .bad {
        color: var(--bad);
      }
      .warn {
        color: var(--warn);
      }
      .muted {
        color: var(--muted);
      }
      .pill {
        display: inline-block;
        margin-top: 6px;
        margin-right: 6px;
        padding: 2px 8px;
        border-radius: 999px;
        border: 1px solid var(--line);
        font-size: 12px;
      }
      .row {
        display: flex;
        gap: 8px;
        margin-top: 8px;
        flex-wrap: wrap;
      }
      .row > * {
        min-width: 0;
      }
      input,
      select,
      textarea,
      button {
        border: 1px solid var(--line);
        background: #0f1a36;
        color: var(--text);
        border-radius: 8px;
        padding: 8px 10px;
        font: inherit;
      }
      textarea {
        width: 100%;
        min-height: 80px;
        resize: vertical;
      }
      button {
        cursor: pointer;
      }
      .grow {
        flex: 1;
      }
      .w120 {
        width: 120px;
      }
      .w160 {
        width: 160px;
      }
      pre {
        margin: 8px 0 0;
        padding: 10px;
        background: #0c1430;
        border: 1px solid #24365f;
        border-radius: 10px;
        overflow: auto;
        white-space: pre-wrap;
      }
      #eventLog {
        max-height: 320px;
      }
      .split {
        display: grid;
        gap: 12px;
        grid-template-columns: 1.2fr 1fr;
      }
      @media (max-width: 1000px) {
        .split {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <h1>nxclaw web console</h1>
      <div class="sub">Lightweight web operations console usable without Slack/Telegram</div>

      <div class="grid">
        <div class="panel"><div class="label">Model</div><div class="value" id="model">-</div></div>
        <div class="panel"><div class="label">Busy</div><div class="value" id="busy">-</div></div>
        <div class="panel"><div class="label">Queue Depth</div><div class="value" id="queueDepth">-</div></div>
        <div class="panel"><div class="label">Memory</div><div class="value" id="memory">-</div></div>
        <div class="panel"><div class="label">Objectives</div><div class="value" id="objectives">-</div></div>
        <div class="panel"><div class="label">Task Health</div><div class="value" id="taskHealth">-</div></div>
        <div class="panel"><div class="label">Task Queue</div><div class="value" id="taskQueue">-</div></div>
        <div class="panel"><div class="label">Skills</div><div class="value" id="skills">-</div></div>
      </div>

      <div class="panel">
        <div class="label">Channels</div>
        <div id="channels" class="value muted">-</div>
      </div>

      <div class="split">
        <div>
          <div class="panel">
            <div class="label">Web Session Chat</div>
            <div class="row">
              <select id="sessionSelect" class="grow"></select>
              <button id="newSessionBtn">New Session</button>
              <button id="archiveSessionBtn">Archive</button>
            </div>
            <div class="row">
              <input id="rotateMinutes" class="w120" type="number" min="5" max="1440" value="90" />
              <div class="muted">auto-create a new session after this many idle minutes</div>
            </div>
            <div class="row">
              <input id="promptInput" class="grow" placeholder="웹 채널로 에이전트에게 지시" />
              <button id="sendBtn">Send</button>
            </div>
            <pre id="sessionMeta">-</pre>
            <pre id="promptReply">-</pre>
          </div>

          <div class="panel">
            <div class="label">Memory Console</div>
            <div class="row">
              <input id="memoryQuery" class="grow" placeholder="memory search query" />
              <button id="memorySearchBtn">Search</button>
              <button id="memorySyncBtn">Sync</button>
            </div>
            <pre id="memorySearchResult">-</pre>
            <div class="row">
              <input id="noteTitle" class="grow" placeholder="Long-term note title" />
              <input id="noteTags" class="grow" placeholder="tags (comma separated)" />
            </div>
            <textarea id="noteContent" placeholder="Long-term memory note content"></textarea>
            <div class="row">
              <button id="noteSaveBtn">Save Note</button>
              <input id="compactReason" class="grow" placeholder="compact reason" />
              <button id="compactBtn">Compact</button>
            </div>
            <div class="row">
              <button id="refreshMemoryBtn">Refresh Memory</button>
            </div>
            <pre id="memoryStats">-</pre>
            <pre id="memoryRecent">-</pre>
          </div>
        </div>

        <div>
          <div class="panel">
            <div class="label">Settings</div>
            <div class="row">
              <select id="providerSelect" class="grow">
                <option value="google-gemini-cli">google-gemini-cli</option>
                <option value="openai-codex">openai-codex</option>
                <option value="anthropic">anthropic</option>
              </select>
              <input id="defaultModelInput" class="grow" placeholder="default model (optional)" />
            </div>
            <div class="row">
              <label><input id="autoEnabled" type="checkbox" /> autonomous enabled</label>
              <input id="autoInterval" class="w160" type="number" min="5000" step="1000" placeholder="interval ms" />
            </div>
            <div class="row">
              <input id="autoGoal" class="grow" placeholder="autonomous goal" />
            </div>
            <div class="row">
              <input id="maxQueueDepth" class="w120" type="number" min="10" max="2000" placeholder="queue depth" />
              <input id="maxConcurrentTasks" class="w120" type="number" min="1" max="64" placeholder="tasks" />
              <input id="maxSessionLanes" class="w120" type="number" min="20" max="2000" placeholder="session lanes" />
              <input id="maxSessionIdleMinutes" class="w120" type="number" min="5" max="1440" placeholder="session idle min" />
            </div>
            <div class="row">
              <label><input id="sessionMemoryEnabled" type="checkbox" /> session memory</label>
              <label><input id="vectorEnabled" type="checkbox" /> vector search</label>
            </div>
            <div class="row">
              <button id="saveSettingsBtn">Save Settings</button>
            </div>
            <pre id="settingsResult">-</pre>
            <pre id="authStatus">-</pre>
          </div>

          <div class="panel">
            <div class="label">Autonomous</div>
            <pre id="autonomous">-</pre>
          </div>

          <div class="panel">
            <div class="label">Active Run</div>
            <pre id="activeRun">-</pre>
          </div>

          <div class="panel">
            <div class="label">Tasks</div>
            <pre id="tasks">[]</pre>
          </div>

          <div class="panel">
            <div class="label">Chrome Sessions</div>
            <pre id="chrome">[]</pre>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="label">Live Events (<span id="eventStatus" class="warn">connecting</span>)</div>
        <pre id="eventLog">waiting...</pre>
      </div>

      <div class="panel">
        <div class="label">Last Error</div>
        <pre id="lastError">-</pre>
      </div>
    </div>

    <script>
      const modelEl = document.getElementById("model");
      const busyEl = document.getElementById("busy");
      const queueDepthEl = document.getElementById("queueDepth");
      const memoryEl = document.getElementById("memory");
      const objEl = document.getElementById("objectives");
      const taskHealthEl = document.getElementById("taskHealth");
      const taskQueueEl = document.getElementById("taskQueue");
      const skillsEl = document.getElementById("skills");
      const channelsEl = document.getElementById("channels");
      const autonomousEl = document.getElementById("autonomous");
      const activeRunEl = document.getElementById("activeRun");
      const tasksEl = document.getElementById("tasks");
      const chromeEl = document.getElementById("chrome");
      const lastErrorEl = document.getElementById("lastError");

      const eventStatusEl = document.getElementById("eventStatus");
      const eventLogEl = document.getElementById("eventLog");

      const sessionSelectEl = document.getElementById("sessionSelect");
      const sessionMetaEl = document.getElementById("sessionMeta");
      const rotateMinutesEl = document.getElementById("rotateMinutes");
      const newSessionBtn = document.getElementById("newSessionBtn");
      const archiveSessionBtn = document.getElementById("archiveSessionBtn");

      const inputEl = document.getElementById("promptInput");
      const sendBtn = document.getElementById("sendBtn");
      const replyEl = document.getElementById("promptReply");

      const providerSelectEl = document.getElementById("providerSelect");
      const defaultModelInputEl = document.getElementById("defaultModelInput");
      const autoEnabledEl = document.getElementById("autoEnabled");
      const autoIntervalEl = document.getElementById("autoInterval");
      const autoGoalEl = document.getElementById("autoGoal");
      const maxQueueDepthEl = document.getElementById("maxQueueDepth");
      const maxConcurrentTasksEl = document.getElementById("maxConcurrentTasks");
      const maxSessionLanesEl = document.getElementById("maxSessionLanes");
      const maxSessionIdleMinutesEl = document.getElementById("maxSessionIdleMinutes");
      const sessionMemoryEnabledEl = document.getElementById("sessionMemoryEnabled");
      const vectorEnabledEl = document.getElementById("vectorEnabled");
      const saveSettingsBtn = document.getElementById("saveSettingsBtn");
      const settingsResultEl = document.getElementById("settingsResult");
      const authStatusEl = document.getElementById("authStatus");

      const memoryQueryEl = document.getElementById("memoryQuery");
      const memorySearchBtn = document.getElementById("memorySearchBtn");
      const memorySearchResultEl = document.getElementById("memorySearchResult");
      const memorySyncBtn = document.getElementById("memorySyncBtn");
      const noteTitleEl = document.getElementById("noteTitle");
      const noteTagsEl = document.getElementById("noteTags");
      const noteContentEl = document.getElementById("noteContent");
      const noteSaveBtn = document.getElementById("noteSaveBtn");
      const compactReasonEl = document.getElementById("compactReason");
      const compactBtn = document.getElementById("compactBtn");
      const refreshMemoryBtn = document.getElementById("refreshMemoryBtn");
      const memoryStatsEl = document.getElementById("memoryStats");
      const memoryRecentEl = document.getElementById("memoryRecent");

      const eventLines = [];
      let currentSessionId = "";
      let sessions = [];

      function formatTs(ts) {
        if (!ts) return "-";
        const date = new Date(ts);
        if (Number.isNaN(date.getTime())) return "-";
        return date.toLocaleString();
      }

      async function fetchJson(url, init) {
        const res = await fetch(url, init);
        const body = await res.json();
        if (!res.ok || body.ok === false) {
          throw new Error(String(body.error || "request failed"));
        }
        return body;
      }

      function pushEventLine(line) {
        eventLines.push(line);
        if (eventLines.length > 220) {
          eventLines.splice(0, eventLines.length - 220);
        }
        eventLogEl.textContent = eventLines.join("\\n") || "waiting...";
      }

      function pushEvent(event) {
        if (!event || !event.type) return;
        const at = formatTs(typeof event.ts === "number" ? event.ts : Date.now());
        const payload = event.payload ? JSON.stringify(event.payload) : "";
        pushEventLine(payload ? at + " | " + event.type + " | " + payload : at + " | " + event.type);
      }

      function renderSessions(preferredId) {
        const target = preferredId || currentSessionId;
        sessionSelectEl.innerHTML = "";
        for (const item of sessions) {
          const option = document.createElement("option");
          option.value = item.sessionId;
          const updated = item.lastUsedAt ? new Date(item.lastUsedAt).toLocaleTimeString() : "-";
          option.textContent = item.sessionId + " | msgs=" + item.messageCount + " | " + updated;
          sessionSelectEl.appendChild(option);
        }
        if (sessions.length === 0) {
          const option = document.createElement("option");
          option.value = "";
          option.textContent = "(no session)";
          sessionSelectEl.appendChild(option);
          currentSessionId = "";
          return;
        }
        const pick = sessions.some((s) => s.sessionId === target) ? target : sessions[0].sessionId;
        sessionSelectEl.value = pick;
        currentSessionId = pick;
        renderSessionMeta();
      }

      function renderSessionMeta() {
        const current = sessions.find((s) => s.sessionId === currentSessionId);
        if (!current) {
          sessionMetaEl.textContent = "session not selected";
          return;
        }
        sessionMetaEl.textContent = JSON.stringify({
          sessionId: current.sessionId,
          createdAt: current.createdAt,
          lastUsedAt: current.lastUsedAt,
          active: !!current.active,
          messageCount: current.messageCount
        }, null, 2);
      }

      async function refreshSessions(preferredId) {
        const body = await fetchJson("/api/sessions");
        sessions = Array.isArray(body.sessions) ? body.sessions : [];
        if (sessions.length === 0) {
          const created = await fetchJson("/api/sessions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({})
          });
          sessions = created.session ? [created.session] : [];
        }
        renderSessions(preferredId);
      }

      async function createSession() {
        const body = await fetchJson("/api/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({})
        });
        if (body.session) {
          sessions.unshift(body.session);
          renderSessions(body.session.sessionId);
        }
      }

      async function archiveCurrentSession() {
        if (!currentSessionId || sessions.length <= 1) return;
        await fetchJson("/api/sessions/archive", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: currentSessionId })
        });
        await refreshSessions();
      }

      async function maybeRotateSession() {
        const current = sessions.find((s) => s.sessionId === currentSessionId);
        if (!current) return;
        const rotateMinutes = Math.max(5, Number(rotateMinutesEl.value || 90));
        const last = Date.parse(current.lastUsedAt || current.createdAt || Date.now());
        if (!Number.isFinite(last)) return;
        const ageMinutes = (Date.now() - last) / 60000;
        if (ageMinutes < rotateMinutes) return;
        await createSession();
      }

      function paint(state) {
        const tasks = Array.isArray(state.tasks) ? state.tasks : [];
        const queuedStatuses = new Set(["queued", "pending", "scheduled", "retry_waiting"]);
        const runningStatuses = new Set(["running", "starting"]);
        const queued = tasks.filter((task) => queuedStatuses.has(String(task && task.status || ""))).length;
        const running = tasks.filter((task) => runningStatuses.has(String(task && task.status || ""))).length;

        modelEl.textContent = state.model || "-";
        busyEl.innerHTML = state.busy ? '<span class="warn">running</span>' : '<span class="ok">idle</span>';
        queueDepthEl.textContent = String(state.queueDepth || 0);
        memoryEl.textContent =
          "raw=" + (state.memory && state.memory.raw || 0) +
          ", compact=" + (state.memory && state.memory.compact || 0) +
          ", soulJournal=" + (state.memory && state.memory.soulJournal || 0) +
          ", chunks=" + (state.memory && state.memory.indexChunks || 0) +
          ", vector=" + (state.memory && state.memory.vector && state.memory.vector.provider || "off");
        objEl.textContent = JSON.stringify(state.objectives || {});
        taskHealthEl.textContent = JSON.stringify(state.taskHealth || {});
        taskQueueEl.textContent = JSON.stringify({
          queued,
          running,
          total: tasks.length
        });
        skillsEl.textContent = JSON.stringify(state.skills || {});
        channelsEl.innerHTML = (state.channels || [])
          .map((entry) => '<span class="pill ' + (entry.active ? "ok" : "bad") + '">' + entry.name + ":" + (entry.active ? "on" : "off") + "</span>")
          .join(" ");
        autonomousEl.textContent = JSON.stringify(state.autonomous || {}, null, 2);
        activeRunEl.textContent = JSON.stringify(state.activeRun || {}, null, 2);
        tasksEl.textContent = JSON.stringify(tasks, null, 2);
        chromeEl.textContent = JSON.stringify(state.chromeSessions || [], null, 2);
        lastErrorEl.textContent = state.lastError || "-";

        if (Array.isArray(state.webSessions) && state.webSessions.length > 0) {
          sessions = state.webSessions;
          renderSessions(currentSessionId);
        }
      }

      async function tick() {
        try {
          const state = await fetchJson("/api/state");
          paint(state);
        } catch (error) {
          lastErrorEl.textContent = "dashboard fetch error: " + String(error);
        }
      }

      function connectEvents() {
        const es = new EventSource("/api/events/stream");
        es.onopen = () => {
          eventStatusEl.className = "ok";
          eventStatusEl.textContent = "connected";
        };
        es.onmessage = (evt) => {
          try {
            pushEvent(JSON.parse(evt.data));
          } catch {
            pushEventLine("event parse error");
          }
        };
        es.onerror = () => {
          eventStatusEl.className = "warn";
          eventStatusEl.textContent = "reconnecting";
        };
      }

      async function loadSettings() {
        const body = await fetchJson("/api/settings");
        const cfg = body.settings || {};
        providerSelectEl.value = cfg.defaultProvider || "google-gemini-cli";
        defaultModelInputEl.value = cfg.defaultModel || "";
        autoEnabledEl.checked = !!(cfg.autonomous && cfg.autonomous.enabled);
        autoIntervalEl.value = String(cfg.autonomous && cfg.autonomous.intervalMs || 90000);
        autoGoalEl.value = cfg.autonomous && cfg.autonomous.goal || "";
        maxQueueDepthEl.value = String(cfg.runtime && cfg.runtime.maxQueueDepth || 100);
        maxConcurrentTasksEl.value = String(cfg.runtime && cfg.runtime.maxConcurrentTasks || 6);
        maxSessionLanesEl.value = String(cfg.runtime && cfg.runtime.maxSessionLanes || 240);
        maxSessionIdleMinutesEl.value = String(cfg.runtime && cfg.runtime.maxSessionIdleMinutes || 240);
        sessionMemoryEnabledEl.checked = !!(cfg.memory && cfg.memory.sessionMemoryEnabled);
        vectorEnabledEl.checked = !!(cfg.memory && cfg.memory.vectorEnabled);
        authStatusEl.textContent = JSON.stringify({
          auth: body.auth || {},
          channels: body.channels || {}
        }, null, 2);
        settingsResultEl.textContent = "settings loaded";
      }

      async function saveSettings() {
        const payload = {
          defaultProvider: providerSelectEl.value,
          defaultModel: defaultModelInputEl.value.trim(),
          autonomous: {
            enabled: !!autoEnabledEl.checked,
            intervalMs: Number(autoIntervalEl.value || 90000),
            goal: autoGoalEl.value
          },
          runtime: {
            maxQueueDepth: Number(maxQueueDepthEl.value || 100),
            maxConcurrentTasks: Number(maxConcurrentTasksEl.value || 6),
            maxSessionLanes: Number(maxSessionLanesEl.value || 240),
            maxSessionIdleMinutes: Number(maxSessionIdleMinutesEl.value || 240)
          },
          memory: {
            sessionMemoryEnabled: !!sessionMemoryEnabledEl.checked,
            vectorEnabled: !!vectorEnabledEl.checked
          }
        };
        const body = await fetchJson("/api/settings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ settings: payload })
        });
        settingsResultEl.textContent = JSON.stringify({
          warning: body.warning || null,
          settings: body.settings || {}
        }, null, 2);
      }

      async function refreshMemory() {
        const stats = await fetchJson("/api/memory/stats");
        const recent = await fetchJson("/api/memory/recent?limit=24");
        memoryStatsEl.textContent = JSON.stringify(stats.stats || {}, null, 2);
        memoryRecentEl.textContent = JSON.stringify(recent.items || [], null, 2);
      }

      async function searchMemory() {
        const q = memoryQueryEl.value.trim();
        if (!q) return;
        const params = new URLSearchParams({
          q,
          limit: "20"
        });
        if (currentSessionId) {
          params.set("sessionKey", currentSessionId);
          params.set("mode", "session_strict");
        }
        const body = await fetchJson("/api/memory/search?" + params.toString());
        memorySearchResultEl.textContent = JSON.stringify(body.items || [], null, 2);
      }

      async function saveMemoryNote() {
        const content = noteContentEl.value.trim();
        if (!content) return;
        const body = await fetchJson("/api/memory/note", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: noteTitleEl.value.trim() || "Dashboard note",
            tags: noteTagsEl.value.trim(),
            content
          })
        });
        noteContentEl.value = "";
        memorySearchResultEl.textContent = JSON.stringify(body.note || {}, null, 2);
        await refreshMemory();
      }

      async function compactMemory() {
        const body = await fetchJson("/api/memory/compact", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason: compactReasonEl.value.trim() || "dashboard_manual" })
        });
        memorySearchResultEl.textContent = JSON.stringify(body.result || { compacted: false }, null, 2);
        await refreshMemory();
      }

      async function syncMemory() {
        const body = await fetchJson("/api/memory/sync", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({})
        });
        memoryStatsEl.textContent = JSON.stringify(body.stats || {}, null, 2);
      }

      sessionSelectEl.addEventListener("change", () => {
        currentSessionId = sessionSelectEl.value;
        renderSessionMeta();
      });

      newSessionBtn.addEventListener("click", async () => {
        try {
          await createSession();
        } catch (error) {
          replyEl.textContent = String(error);
        }
      });

      archiveSessionBtn.addEventListener("click", async () => {
        try {
          await archiveCurrentSession();
        } catch (error) {
          replyEl.textContent = String(error);
        }
      });

      sendBtn.addEventListener("click", async () => {
        const message = inputEl.value.trim();
        if (!message) return;

        sendBtn.disabled = true;
        try {
          await maybeRotateSession();
          const body = await fetchJson("/api/prompt", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              message,
              sessionId: currentSessionId
            })
          });
          replyEl.textContent = body.reply || "-";
          inputEl.value = "";
          await refreshSessions(currentSessionId);
          await refreshMemory();
        } catch (error) {
          replyEl.textContent = String(error);
        } finally {
          sendBtn.disabled = false;
        }
      });

      saveSettingsBtn.addEventListener("click", async () => {
        saveSettingsBtn.disabled = true;
        try {
          await saveSettings();
          await tick();
        } catch (error) {
          settingsResultEl.textContent = String(error);
        } finally {
          saveSettingsBtn.disabled = false;
        }
      });

      memorySearchBtn.addEventListener("click", async () => {
        try {
          await searchMemory();
        } catch (error) {
          memorySearchResultEl.textContent = String(error);
        }
      });

      memorySyncBtn.addEventListener("click", async () => {
        try {
          await syncMemory();
        } catch (error) {
          memorySearchResultEl.textContent = String(error);
        }
      });

      noteSaveBtn.addEventListener("click", async () => {
        noteSaveBtn.disabled = true;
        try {
          await saveMemoryNote();
        } catch (error) {
          memorySearchResultEl.textContent = String(error);
        } finally {
          noteSaveBtn.disabled = false;
        }
      });

      compactBtn.addEventListener("click", async () => {
        compactBtn.disabled = true;
        try {
          await compactMemory();
        } catch (error) {
          memorySearchResultEl.textContent = String(error);
        } finally {
          compactBtn.disabled = false;
        }
      });

      refreshMemoryBtn.addEventListener("click", async () => {
        try {
          await refreshMemory();
        } catch (error) {
          memorySearchResultEl.textContent = String(error);
        }
      });

      connectEvents();
      Promise.all([tick(), loadSettings(), refreshSessions(), refreshMemory()]).catch((error) => {
        lastErrorEl.textContent = String(error);
      });
      setInterval(tick, 2500);
    </script>
  </body>
</html>`;
}
