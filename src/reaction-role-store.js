import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const REACTION_ROLE_FILE = path.resolve("data/reaction-roles.json");
let saveQueue = Promise.resolve();

export function getReactionKey(emoji) {
  return emoji.id ?? emoji.name;
}

export async function loadReactionRoles() {
  try {
    const data = JSON.parse(await readFile(REACTION_ROLE_FILE, "utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("Reaction-role data must be a JSON object.");
    }
    return data;
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error(`Could not read reaction-role data at ${REACTION_ROLE_FILE}: ${error.message}`, { cause: error });
  }
}

export function saveReactionRoles(data) {
  const contents = `${JSON.stringify(data, null, 2)}\n`;
  const operation = saveQueue.catch(() => {}).then(async () => {
    await mkdir(path.dirname(REACTION_ROLE_FILE), { recursive: true });
    const temporaryFile = `${REACTION_ROLE_FILE}.tmp`;
    await writeFile(temporaryFile, contents, "utf8");
    await rename(temporaryFile, REACTION_ROLE_FILE);
  });
  saveQueue = operation;
  return operation;
}

export function setReactionRole(data, guildId, channelId, messageId, emojiKey, roleId) {
  const updated = structuredClone(data);
  const guildEntries = updated[guildId] ?? {};
  const message = guildEntries[messageId] ?? { channelId, roles: {} };
  if (message.channelId !== channelId) {
    throw new Error("The message ID is already registered in a different channel.");
  }
  if (message.roles[emojiKey]) {
    throw new Error("That emoji already has a role on this message.");
  }
  message.roles[emojiKey] = roleId;
  guildEntries[messageId] = message;
  updated[guildId] = guildEntries;
  return updated;
}
