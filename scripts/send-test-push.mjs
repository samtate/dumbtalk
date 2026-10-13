import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createPushService } from "../push-service.mjs";

const dataDir = process.env.DATA_DIR || "/data";
const configPath = join(dataDir, "app", "config.json");
const deviceId = process.argv[2];

let config;
try {
  config = JSON.parse(await readFile(configPath, "utf8"));
} catch (error) {
  console.error(`Could not read ${configPath}: ${error.message}`);
  process.exitCode = 1;
  process.exit();
}

const devices = Array.isArray(config.pushSubscriptions) ? config.pushSubscriptions : [];
if (!devices.length) {
  console.error("No UnifiedPush subscriptions are registered.");
  process.exitCode = 1;
  process.exit();
}
if (deviceId && !devices.some(item => item.deviceId === deviceId)) {
  console.error(`Unknown device ID: ${deviceId}`);
  console.error(`Registered IDs: ${devices.map(item => item.deviceId).join(" ")}`);
  process.exitCode = 1;
  process.exit();
}

const persist = async () => {
  await mkdir(join(dataDir, "app"), { recursive: true });
  const temporary = `${configPath}.tmp`;
  await writeFile(temporary, JSON.stringify(config), { mode: 0o600 });
  await rename(temporary, configPath);
};
const push = createPushService({
  config,
  persist,
  log: (message, detail) => console.error(`[push] ${message}`, detail || ""),
});
const result = await push.sendNow({ test: true, deviceId });
console.log(JSON.stringify(result));
if (result.sent < 1) process.exitCode = 1;
