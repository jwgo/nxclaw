import path from "node:path";
import crypto from "node:crypto";
import { writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";
import { ensureDir } from "../utils/fs.js";

export class ChromeController {
  constructor({
    mode = "launch",
    cdpUrl = "http://127.0.0.1:9222",
    cdpConnectTimeoutMs = 15_000,
    cdpReuseExistingPage = true,
    cdpFallbackToLaunch = true,
    headless = true,
    executablePath,
    screenshotDir,
    maxSessions = 6,
    eventBus = null,
  }) {
    this.mode = String(mode || "launch").trim().toLowerCase() === "cdp" ? "cdp" : "launch";
    this.cdpUrl = String(cdpUrl || "").trim() || "http://127.0.0.1:9222";
    this.cdpConnectTimeoutMs = Math.max(1_000, Number(cdpConnectTimeoutMs) || 15_000);
    this.cdpReuseExistingPage = cdpReuseExistingPage !== false;
    this.cdpFallbackToLaunch = cdpFallbackToLaunch !== false;
    this.headless = headless !== false;
    this.executablePath = executablePath;
    this.screenshotDir = screenshotDir;
    this.maxSessions = Math.max(1, Number(maxSessions) || 6);
    this.eventBus = eventBus;
    this.browser = null;
    this.activeMode = this.mode;
    this.sessions = new Map();
  }

  emit(type, payload = {}) {
    if (this.eventBus) {
      this.eventBus.emit(type, payload);
    }
  }

  async ensureBrowser() {
    if (this.browser) {
      return this.browser;
    }

    this.activeMode = this.mode;

    if (this.mode === "cdp") {
      try {
        this.browser = await chromium.connectOverCDP(this.cdpUrl, {
          timeout: this.cdpConnectTimeoutMs,
        });
        this.activeMode = "cdp";
        this.emit("chrome.browser.start", {
          mode: this.activeMode,
          cdpUrl: this.cdpUrl,
          cdpReuseExistingPage: this.cdpReuseExistingPage,
        });
        return this.browser;
      } catch (error) {
        const reason = String(error?.message || error || "cdp connect failed");
        if (!(this.cdpFallbackToLaunch && this.executablePath)) {
          throw new Error(
            `CDP connect failed (${reason}). Check NXCLAW_CHROME_CDP_URL or set NXCLAW_CHROME_CDP_FALLBACK_TO_LAUNCH=true with NXCLAW_CHROME_PATH.`,
          );
        }
        this.activeMode = "launch";
        this.emit("chrome.browser.failover", {
          from: "cdp",
          to: "launch",
          cdpUrl: this.cdpUrl,
          reason,
        });
      }
    }

    if (!this.executablePath) {
      throw new Error(
        "Chrome executable path is required in launch mode. Set NXCLAW_CHROME_PATH or use NXCLAW_CHROME_MODE=cdp.",
      );
    }

    this.browser = await chromium.launch({
      executablePath: this.executablePath,
      headless: this.headless,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    this.emit("chrome.browser.start", {
      mode: this.activeMode,
      executablePath: this.executablePath,
      headless: this.headless,
    });
    return this.browser;
  }

  listSessions() {
    return [...this.sessions.values()].map((entry) => ({
      id: entry.id,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      mode: entry.mode || this.activeMode,
      attached: !!entry.attached,
      reusedExistingPage: !!entry.reusedExistingPage,
      url: entry.page.isClosed() ? "(closed)" : entry.page.url(),
      title: entry.title || "",
      refCount: Number(entry.refCount || 0),
      lastSnapshotAt: entry.lastSnapshotAt || null,
    }));
  }

  async ensureCapacity() {
    if (this.sessions.size < this.maxSessions) {
      return;
    }

    const oldest = [...this.sessions.values()].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))[0];
    if (oldest) {
      await this.closeSession(oldest.id);
      this.emit("chrome.session.evicted", { sessionId: oldest.id });
    }
  }

  isBlankPageUrl(url) {
    const value = String(url || "").trim().toLowerCase();
    return (
      !value ||
      value === "about:blank" ||
      value === "chrome://newtab/" ||
      value === "chrome://new-tab-page/" ||
      value === "edge://newtab/"
    );
  }

  getCurrentSessionPages() {
    return new Set(
      [...this.sessions.values()]
        .map((item) => item.page)
        .filter(Boolean),
    );
  }

  async openLaunchSession(browser) {
    const context = await browser.newContext();
    const page = await context.newPage();
    return {
      context,
      page,
      ownsContext: true,
      ownsPage: true,
      reusedExistingPage: false,
      attached: false,
    };
  }

  async openCdpSession(browser) {
    const sessionsPages = this.getCurrentSessionPages();
    const contexts = browser.contexts();

    if (this.cdpReuseExistingPage) {
      for (const context of contexts) {
        for (const page of context.pages()) {
          if (sessionsPages.has(page) || page.isClosed()) {
            continue;
          }
          const url = page.url();
          if (!this.isBlankPageUrl(url)) {
            return {
              context,
              page,
              ownsContext: false,
              ownsPage: false,
              reusedExistingPage: true,
              attached: true,
            };
          }
        }
      }

      for (const context of contexts) {
        for (const page of context.pages()) {
          if (sessionsPages.has(page) || page.isClosed()) {
            continue;
          }
          return {
            context,
            page,
            ownsContext: false,
            ownsPage: false,
            reusedExistingPage: true,
            attached: true,
          };
        }
      }
    }

    let context = contexts[0] || null;
    let ownsContext = false;
    if (!context) {
      context = await browser.newContext();
      ownsContext = true;
    }

    const page = await context.newPage();
    return {
      context,
      page,
      ownsContext,
      ownsPage: true,
      reusedExistingPage: false,
      attached: true,
    };
  }

  async openSession({ url = "about:blank" }) {
    await this.ensureCapacity();
    const browser = await this.ensureBrowser();
    const browserMode = this.activeMode || this.mode;

    const opened =
      browserMode === "cdp"
        ? await this.openCdpSession(browser)
        : await this.openLaunchSession(browser);
    const context = opened.context;
    const page = opened.page;
    const cdp = await context.newCDPSession(page).catch(() => null);
    if (cdp) {
      await cdp.send("Page.enable").catch(() => undefined);
      await cdp.send("Runtime.enable").catch(() => undefined);
    }

    const targetUrl = String(url || "").trim() || "about:blank";
    if (targetUrl !== "about:blank") {
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    }

    const session = {
      id: crypto.randomUUID(),
      context,
      page,
      cdp,
      ownsContext: !!opened.ownsContext,
      ownsPage: !!opened.ownsPage,
      reusedExistingPage: !!opened.reusedExistingPage,
      attached: !!opened.attached,
      mode: browserMode,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      title: await page.title().catch(() => ""),
      refCount: 0,
      lastSnapshotAt: null,
    };

    this.sessions.set(session.id, session);
    this.emit("chrome.session.open", {
      sessionId: session.id,
      url: page.url(),
      title: session.title,
      cdpEnabled: !!cdp,
      mode: session.mode,
      attached: !!session.attached,
      reusedExistingPage: !!session.reusedExistingPage,
    });

    return {
      id: session.id,
      url: page.url(),
      title: session.title,
    };
  }

  getSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Chrome session not found: ${sessionId}`);
    }
    if (session.page?.isClosed?.()) {
      this.sessions.delete(sessionId);
      throw new Error(`Chrome session is closed: ${sessionId}`);
    }
    return session;
  }

  async navigate({ sessionId, url }) {
    const session = this.getSession(sessionId);
    await session.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    session.updatedAt = new Date().toISOString();
    session.title = await session.page.title();
    this.emit("chrome.session.navigate", { sessionId, url: session.page.url() });
    return { id: session.id, url: session.page.url(), title: session.title };
  }

  async click({ sessionId, selector }) {
    const session = this.getSession(sessionId);
    const locator = session.page.locator(selector).first();
    await locator.waitFor({ state: "visible", timeout: 15_000 });
    await locator.click({ timeout: 15_000 });
    await session.page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => undefined);
    session.updatedAt = new Date().toISOString();
    this.emit("chrome.session.click", { sessionId, selector });
    return { id: session.id, clicked: selector, url: session.page.url() };
  }

  async type({ sessionId, selector, text, clear = true }) {
    const session = this.getSession(sessionId);
    const locator = session.page.locator(selector).first();
    await locator.waitFor({ state: "visible", timeout: 15_000 });
    if (clear) {
      await locator.fill("", { timeout: 15_000 }).catch(() => undefined);
      await locator
        .fill(String(text), { timeout: 15_000 })
        .catch(async () => {
          await locator.click({ timeout: 15_000 });
          await session.page.keyboard.type(String(text));
        });
    } else {
      await locator.click({ timeout: 15_000 });
      await session.page.keyboard.type(String(text));
    }
    session.updatedAt = new Date().toISOString();
    this.emit("chrome.session.type", { sessionId, selector, chars: String(text).length });
    return { id: session.id, typed: selector, chars: String(text).length };
  }

  async waitFor({ sessionId, selector, timeoutMs = 15_000 }) {
    const session = this.getSession(sessionId);
    await session.page.locator(selector).first().waitFor({ timeout: timeoutMs });
    session.updatedAt = new Date().toISOString();
    this.emit("chrome.session.wait", { sessionId, selector, timeoutMs });
    return { id: session.id, selector, timeoutMs, found: true };
  }

  async extractText({ sessionId, selector }) {
    const session = this.getSession(sessionId);
    const locator = session.page.locator(selector).first();
    await locator.waitFor({ timeout: 15_000 });
    const text =
      (await locator.innerText({ timeout: 15_000 }).catch(() => null)) ??
      (await locator.textContent({ timeout: 15_000 }).catch(() => "")) ??
      "";
    session.updatedAt = new Date().toISOString();
    this.emit("chrome.session.extract", { sessionId, selector, chars: String(text).length });
    return { id: session.id, selector, text: String(text).trim() };
  }

  async evaluate({ sessionId, script }) {
    const session = this.getSession(sessionId);
    const result = await session.page.evaluate(
      (source) => {
        return (0, eval)(source);
      },
      String(script || ""),
    );

    session.updatedAt = new Date().toISOString();
    this.emit("chrome.session.evaluate", { sessionId, scriptChars: String(script || "").length });
    return {
      id: session.id,
      result:
        typeof result === "string" ? result : JSON.stringify(result, null, 2),
    };
  }

  async screenshot({ sessionId, fileName = "" }) {
    const session = this.getSession(sessionId);
    await ensureDir(this.screenshotDir);
    const safe = fileName.trim() || `shot-${Date.now()}.png`;
    const fullPath = path.join(this.screenshotDir, safe);
    await session.page
      .screenshot({ path: fullPath, fullPage: true })
      .catch(async () => {
        if (!session.cdp) {
          throw new Error("Playwright screenshot failed and CDP is unavailable.");
        }
        const shot = await session.cdp.send("Page.captureScreenshot", { format: "png" });
        const bytes = Buffer.from(String(shot.data || ""), "base64");
        await ensureDir(path.dirname(fullPath));
        await writeFile(fullPath, bytes);
      });
    session.updatedAt = new Date().toISOString();
    this.emit("chrome.session.screenshot", { sessionId, path: fullPath });
    return { id: session.id, path: fullPath, url: session.page.url() };
  }

  parseRef(ref) {
    const parsed = Number(ref);
    if (!Number.isFinite(parsed) || parsed < 1 || !Number.isInteger(parsed)) {
      throw new Error(`Invalid snapshot ref: ${ref}`);
    }
    return parsed;
  }

  async snapshot({ sessionId, includeInvisible = false, maxElements = 250 }) {
    const session = this.getSession(sessionId);
    const limit = Math.max(1, Math.min(Number(maxElements) || 250, 500));

    const shot = await session.page.evaluate(
      ({ includeInvisible: includeHidden, maxElements: max }) => {
        const selector = [
          "a[href]",
          "button",
          "input:not([type='hidden'])",
          "textarea",
          "select",
          "[role='button']",
          "[role='link']",
          "[role='menuitem']",
          "[onclick]",
          "[contenteditable='true']",
          "[tabindex]:not([tabindex='-1'])",
          "[aria-label]",
        ].join(",");

        const normalize = (value) =>
          String(value || "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 160);

        const isVisible = (el) => {
          const style = window.getComputedStyle(el);
          if (!style || style.visibility === "hidden" || style.display === "none") {
            return false;
          }
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };

        document.querySelectorAll("[data-nx-ref]").forEach((el) => {
          el.removeAttribute("data-nx-ref");
        });

        const elements = [];
        const seen = new Set();
        let ref = 1;

        for (const raw of Array.from(document.querySelectorAll(selector))) {
          if (!(raw instanceof HTMLElement)) {
            continue;
          }

          if (!includeHidden && !isVisible(raw)) {
            continue;
          }

          const rect = raw.getBoundingClientRect();
          const text = normalize(raw.innerText || raw.textContent || "");
          const key = [
            raw.tagName.toLowerCase(),
            raw.id || "",
            raw.getAttribute("name") || "",
            Math.round(rect.x),
            Math.round(rect.y),
            text.slice(0, 40),
          ].join("|");

          if (seen.has(key)) {
            continue;
          }
          seen.add(key);

          const currentRef = ref++;
          raw.setAttribute("data-nx-ref", String(currentRef));
          elements.push({
            ref: currentRef,
            tag: raw.tagName.toLowerCase(),
            id: raw.id || "",
            role: raw.getAttribute("role") || "",
            name: raw.getAttribute("name") || "",
            type: raw.getAttribute("type") || "",
            text,
            ariaLabel: normalize(raw.getAttribute("aria-label") || ""),
            placeholder: normalize(raw.getAttribute("placeholder") || ""),
            href: raw instanceof HTMLAnchorElement ? raw.href : "",
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          });

          if (elements.length >= max) {
            break;
          }
        }

        return {
          url: location.href,
          title: document.title || "",
          generatedAt: new Date().toISOString(),
          elements,
        };
      },
      { includeInvisible: !!includeInvisible, maxElements: limit },
    );

    let domNodeCount = null;
    if (session.cdp) {
      const cdpResult = await session.cdp
        .send("Runtime.evaluate", {
          expression: "document.querySelectorAll('*').length",
          returnByValue: true,
        })
        .catch(() => null);
      domNodeCount = Number(cdpResult?.result?.value || 0) || null;
    }

    session.updatedAt = new Date().toISOString();
    session.lastSnapshotAt = shot.generatedAt;
    session.refCount = Array.isArray(shot.elements) ? shot.elements.length : 0;
    this.emit("chrome.session.snapshot", {
      sessionId,
      count: session.refCount,
      domNodeCount,
    });

    return {
      id: session.id,
      url: shot.url,
      title: shot.title,
      generatedAt: shot.generatedAt,
      count: session.refCount,
      domNodeCount,
      elements: shot.elements,
    };
  }

  async clickByRef({ sessionId, ref, timeoutMs = 15_000 }) {
    const session = this.getSession(sessionId);
    const safeRef = this.parseRef(ref);
    const selector = `[data-nx-ref="${safeRef}"]`;
    const locator = session.page.locator(selector).first();
    await locator
      .waitFor({ state: "visible", timeout: timeoutMs })
      .catch(() => {
        throw new Error(`Ref ${safeRef} not found. Run nx_chrome_session_snapshot again.`);
      });
    await locator.click({ timeout: timeoutMs });
    await session.page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => undefined);
    session.updatedAt = new Date().toISOString();
    this.emit("chrome.session.ref.click", { sessionId, ref: safeRef });
    return { id: session.id, ref: safeRef, url: session.page.url(), clicked: true };
  }

  async typeByRef({ sessionId, ref, text, clear = true, pressEnter = false, timeoutMs = 15_000 }) {
    const session = this.getSession(sessionId);
    const safeRef = this.parseRef(ref);
    const selector = `[data-nx-ref="${safeRef}"]`;
    const locator = session.page.locator(selector).first();
    await locator
      .waitFor({ state: "visible", timeout: timeoutMs })
      .catch(() => {
        throw new Error(`Ref ${safeRef} not found. Run nx_chrome_session_snapshot again.`);
      });

    if (clear) {
      await locator.fill("", { timeout: timeoutMs }).catch(() => undefined);
      await locator
        .fill(String(text), { timeout: timeoutMs })
        .catch(async () => {
          await locator.click({ timeout: timeoutMs });
          await session.page.keyboard.type(String(text));
        });
    } else {
      await locator.click({ timeout: timeoutMs });
      await session.page.keyboard.type(String(text));
    }

    if (pressEnter) {
      await session.page.keyboard.press("Enter");
    }

    session.updatedAt = new Date().toISOString();
    this.emit("chrome.session.ref.type", {
      sessionId,
      ref: safeRef,
      chars: String(text).length,
      pressEnter: !!pressEnter,
    });
    return {
      id: session.id,
      ref: safeRef,
      chars: String(text).length,
      pressEnter: !!pressEnter,
      typed: true,
    };
  }

  async closeSession(sessionId) {
    const session = this.getSession(sessionId);
    if (session.cdp) {
      await session.cdp.detach().catch(() => undefined);
    }

    if (session.ownsContext) {
      await session.context.close().catch(async () => {
        if (session.ownsPage) {
          await session.page.close().catch(() => undefined);
        }
      });
    } else if (session.ownsPage) {
      await session.page.close().catch(() => undefined);
    }

    this.sessions.delete(sessionId);
    this.emit("chrome.session.close", {
      sessionId,
      mode: session.mode || this.mode,
      attached: !!session.attached,
      reusedExistingPage: !!session.reusedExistingPage,
    });
    return { id: sessionId, closed: true };
  }

  async closeAll() {
    const ids = [...this.sessions.keys()];
    for (const id of ids) {
      await this.closeSession(id).catch(() => undefined);
    }

    if (this.browser) {
      await this.browser.close().catch(() => undefined);
      this.browser = null;
      this.emit("chrome.browser.stop", { mode: this.activeMode });
    }
    this.activeMode = this.mode;
  }
}
