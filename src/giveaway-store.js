import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const GIVEAWAY_FILE = path.resolve("data/giveaways.json");
let saveQueue = Promise.resolve();

export function parseGiveawayDuration(value) {
  const match = /^(\d+)(s|m|h|d|w)$/i.exec(value ?? "");
  if (!match) return null;

  const multipliers = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  const duration = Number(match[1]) * multipliers[match[2].toLowerCase()];
  return Number.isSafeInteger(duration) && duration >= 60_000 && duration <= 30 * 86_400_000
    ? duration
    : null;
}

export function pickGiveawayWinners(entrantIds, winnerCount, random = Math.random) {
  const candidates = [...new Set(entrantIds)];
  for (let index = candidates.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [candidates[index], candidates[swapIndex]] = [candidates[swapIndex], candidates[index]];
  }
  return candidates.slice(0, winnerCount);
}

export async function loadGiveaways() {
  try {
    const data = JSON.parse(await readFile(GIVEAWAY_FILE, "utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("Giveaway data must be a JSON object.");
    }
    return data;
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error(`Could not read giveaway data at ${GIVEAWAY_FILE}: ${error.message}`, { cause: error });
  }
}

export function saveGiveaways(giveaways) {
  const contents = `${JSON.stringify(giveaways, null, 2)}\n`;
  const operation = saveQueue.catch(() => {}).then(async () => {
    await mkdir(path.dirname(GIVEAWAY_FILE), { recursive: true });
    const temporaryFile = `${GIVEAWAY_FILE}.tmp`;
    await writeFile(temporaryFile, contents, "utf8");
    await rename(temporaryFile, GIVEAWAY_FILE);
  });
  saveQueue = operation;
  return operation;
}
