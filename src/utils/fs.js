import fs from "node:fs/promises";
import path from "node:path";

export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true, mode: 0o700 });
}

export async function readJsonOrDefault(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    if (!raw.trim()) {
      return fallback;
    }
    try {
      return JSON.parse(raw);
    } catch {
      const backup = `${filePath}.corrupt-${Date.now()}`;
      await fs.rename(filePath, backup).catch(() => undefined);
      return fallback;
    }
  } catch {
    return fallback;
  }
}

async function writeFileAtomic(filePath, content, mode = 0o600) {
  await ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  let handle = null;
  try {
    handle = await fs.open(tempPath, "w", mode);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(tempPath, filePath);
  } finally {
    if (handle) {
      await handle.close().catch(() => undefined);
    }
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

export async function writeJson(filePath, value) {
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, 0o600);
}

export async function readTextOrDefault(filePath, fallback = "") {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return fallback;
  }
}

export async function writeText(filePath, value) {
  await writeFileAtomic(filePath, String(value ?? ""), 0o600);
}

export async function appendText(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await fs.appendFile(filePath, String(value ?? ""), { mode: 0o600 });
}

export async function readJsonl(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((entry) => entry && typeof entry === "object");
  } catch {
    return [];
  }
}

export async function appendJsonl(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

export async function writeJsonl(filePath, list) {
  const body = list.map((entry) => JSON.stringify(entry)).join("\n");
  await writeFileAtomic(filePath, body.length > 0 ? `${body}\n` : "", 0o600);
}

export async function fileExists(filePath) {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function listFiles(dirPath) {
  try {
    const names = await fs.readdir(dirPath);
    return names.map((name) => path.join(dirPath, name));
  } catch {
    return [];
  }
}
