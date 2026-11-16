import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const CONFIG_FILE = path.resolve("data/ticket-config.json");

export async function loadTicketConfigs() {
  try {
    const config = JSON.parse(await readFile(CONFIG_FILE, "utf8"));
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw new Error("Ticket configuration must be a JSON object.");
    }
    return config;
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error(`Could not read ticket configuration at ${CONFIG_FILE}: ${error.message}`, { cause: error });
  }
}

export async function saveTicketConfigs(configs) {
  await mkdir(path.dirname(CONFIG_FILE), { recursive: true });
  await writeFile(CONFIG_FILE, `${JSON.stringify(configs, null, 2)}\n`, "utf8");
}

export function updateTicketConfig(configs, guildId, patch) {
  const updatedGuild = { ...(configs[guildId] ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete updatedGuild[key];
    else updatedGuild[key] = value;
  }

  const updated = { ...configs };
  if (Object.keys(updatedGuild).length) updated[guildId] = updatedGuild;
  else delete updated[guildId];
  return updated;
}

export function clearTicketConfig(configs, guildId, setting) {
  if (setting === "all") {
    const updated = { ...configs };
    delete updated[guildId];
    return updated;
  }
  const key = setting === "category" ? "categoryId" : "staffRoleId";
  return updateTicketConfig(configs, guildId, { [key]: null });
}

export function getEffectiveTicketConfig(configs, guildId, env = process.env) {
  const saved = configs[guildId] ?? {};
  return {
    categoryId: saved.categoryId ?? env.TICKET_CATEGORY_ID ?? null,
    staffRoleId: saved.staffRoleId ?? env.TICKET_STAFF_ROLE_ID ?? null,
  };
}
