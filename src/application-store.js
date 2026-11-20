import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const APPLICATION_FILE = path.resolve("data/applications.json");
let saveQueue = Promise.resolve();

export function normalizeApplicationName(name) {
  if (typeof name !== "string") return "";
  return name.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

export function getApplicationKey(name) {
  return normalizeApplicationName(name)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

export async function loadApplications() {
  try {
    const data = JSON.parse(await readFile(APPLICATION_FILE, "utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("Application data must be a JSON object.");
    }
    data.guilds ??= {};
    data.submissions ??= {};
    return data;
  } catch (error) {
    if (error.code === "ENOENT") return { guilds: {}, submissions: {} };
    throw new Error(`Could not read application data at ${APPLICATION_FILE}: ${error.message}`, { cause: error });
  }
}

export function saveApplications(data) {
  const contents = `${JSON.stringify(data, null, 2)}\n`;
  const operation = saveQueue.catch(() => {}).then(async () => {
    await mkdir(path.dirname(APPLICATION_FILE), { recursive: true });
    const temporaryFile = `${APPLICATION_FILE}.tmp`;
    await writeFile(temporaryFile, contents, "utf8");
    await rename(temporaryFile, APPLICATION_FILE);
  });
  saveQueue = operation;
  return operation;
}

export function ensureGuildApplications(data, guildId) {
  const updated = structuredClone(data);
  updated.guilds ??= {};
  updated.guilds[guildId] ??= { applications: {}, reviewChannelId: null };
  return updated;
}

export function ensureApplication(data, guildId, applicationKey, application) {
  const updated = ensureGuildApplications(data, guildId);
  updated.guilds[guildId].applications[applicationKey] = application;
  return updated;
}
