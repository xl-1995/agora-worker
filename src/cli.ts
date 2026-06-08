#!/usr/bin/env node
/**
 * agora-worker CLI entrypoint.
 *
 * Usage:
 *   agora-worker init --api-key agk_...             # writes .env
 *   agora-worker start                              # uses .env
 *   agora-worker start --caps intel.deep --chain bsc
 *   agora-worker start --auto                       # built-in handler
 */

import "dotenv/config";
import { promises as fs } from "node:fs";
import { startWorker, type WorkerConfig } from "./worker.js";
import { defaultIntelDeepHandler } from "./default-handler.js";

const DEFAULTS = {
  api: "https://agora-api.chatnext.workers.dev",
  caps: "intel.deep",
  chain: "bsc",
  pollMs: "15000",
  inbox: "./inbox",
  outbox: "./outbox",
  maxInflight: "8",
} as const;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  return process.argv[i + 1];
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const command = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "start";

async function init(): Promise<void> {
  const apiUrl = (arg("api") ?? process.env.AGORA_API_URL ?? DEFAULTS.api).replace(/\/+$/, "");
  const apiKey = arg("api-key") ?? process.env.AGORA_API_KEY;
  const caps = arg("caps") ?? process.env.WORKER_CAPS ?? DEFAULTS.caps;
  const chain = arg("chain") ?? process.env.WORKER_CHAIN ?? DEFAULTS.chain;
  const auto = flag("auto") || process.env.WORKER_AUTO === "1" ? "1" : "0";
  if (!apiKey) {
    console.error("agora-worker init: missing --api-key. Create one in AGORA web app -> Agent Setup.");
    process.exit(1);
  }
  const env = [
    `AGORA_API_URL=${apiUrl}`,
    `AGORA_API_KEY=${apiKey}`,
    `WORKER_CAPS=${caps}`,
    `WORKER_CHAIN=${chain}`,
    `WORKER_INBOX=${DEFAULTS.inbox}`,
    `WORKER_OUTBOX=${DEFAULTS.outbox}`,
    `WORKER_POLL_MS=${DEFAULTS.pollMs}`,
    `WORKER_MAX_INFLIGHT=${DEFAULTS.maxInflight}`,
    `WORKER_AUTO=${auto}`,
    "",
  ].join("\n");
  await fs.writeFile(".env", env, "utf-8");
  await fs.mkdir("inbox", { recursive: true });
  await fs.mkdir("outbox", { recursive: true });
  console.log("agora-worker: wrote .env and created inbox/outbox.");
  console.log("agora-worker: run `agora-worker start` to begin claiming tasks.");
}

if (command === "init") {
  await init();
  process.exit(0);
}

const cfg: WorkerConfig = {
  apiUrl: (arg("api") ?? process.env.AGORA_API_URL ?? DEFAULTS.api).replace(/\/+$/, ""),
  privateKey: process.env.PRIVATE_KEY as `0x${string}` | undefined,
  apiKey: arg("api-key") ?? process.env.AGORA_API_KEY,
  caps: (arg("caps") ?? process.env.WORKER_CAPS ?? DEFAULTS.caps).split(",").map((s) => s.trim()).filter(Boolean),
  chain: arg("chain") ?? process.env.WORKER_CHAIN ?? "",
  inbox: arg("inbox") ?? process.env.WORKER_INBOX ?? DEFAULTS.inbox,
  outbox: arg("outbox") ?? process.env.WORKER_OUTBOX ?? DEFAULTS.outbox,
  pollMs: Number(arg("poll") ?? process.env.WORKER_POLL_MS ?? DEFAULTS.pollMs),
  auto: flag("auto") || process.env.WORKER_AUTO === "1",
  maxInflight: Math.max(1, Number(arg("max-inflight") ?? process.env.WORKER_MAX_INFLIGHT ?? DEFAULTS.maxInflight)),
};

if (!cfg.apiKey && !cfg.privateKey) {
  console.error("agora-worker: missing AGORA_API_KEY. Run `agora-worker init --api-key agk_...` first.");
  process.exit(1);
}

if (cfg.apiKey && !/^agk_[a-f0-9]{64}$/i.test(cfg.apiKey)) {
  console.error("agora-worker: AGORA_API_KEY must start with agk_");
  process.exit(1);
}

if (cfg.privateKey && !/^0x[a-fA-F0-9]{64}$/.test(cfg.privateKey)) {
  console.error("agora-worker: PRIVATE_KEY must be 0x + 64 hex chars");
  process.exit(1);
}

startWorker(cfg, defaultIntelDeepHandler).catch((e) => {
  console.error("agora-worker: fatal", e);
  process.exit(1);
});
