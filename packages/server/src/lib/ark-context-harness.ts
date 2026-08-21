import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { db } from "./database.js";
import { getErrorMessage } from "./errors.js";

const execFileAsync = promisify(execFile);

export const ARK_CONTEXT_ENABLED_SETTING_KEY = "ark_context_enabled";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const CONTEXT_ENV_KEYS = new Set([
  "ARK_SESSION_ID",
  "ARK_SESSION_DIR",
  "ARK_CACHE_DIR",
  "ARK_RECITE_INTERVAL",
  "ARK_KNOWLEDGE_DIR",
  "ARK_REPO_KEY",
]);
const REQUIRED_CONTEXT_ENV_KEYS = [
  "ARK_SESSION_ID",
  "ARK_SESSION_DIR",
  "ARK_CACHE_DIR",
  "ARK_RECITE_INTERVAL",
  "ARK_KNOWLEDGE_DIR",
] as const;

type Logger = Pick<Console, "error" | "warn">;

export interface ArkContextHarnessOptions {
  scriptDirectory?: string;
  timeoutMs?: number;
  ownerPid?: number;
  readSetting?: (key: string) => unknown;
  logger?: Logger;
}

interface ParsedInitOutput {
  enabled: boolean;
  reason?: string;
  env?: Record<string, string>;
}

function resolveScriptDirectory(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(process.cwd(), "ark", "context", "scripts"),
    join(moduleDirectory, "..", "..", "..", "ark", "context", "scripts"),
    join(moduleDirectory, "..", "..", "..", "..", "ark", "context", "scripts"),
  ];
  return (
    candidates.find(candidate =>
      existsSync(join(candidate, "session-init.sh"))
    ) ?? candidates[0]
  );
}

function parseInitOutput(stdout: string): ParsedInitOutput {
  const values = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    if (line === "") continue;
    const separator = line.indexOf("\t");
    if (separator <= 0) throw new Error("invalid TSV output");
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (values.has(key)) throw new Error(`duplicate TSV key: ${key}`);
    values.set(key, value);
  }

  const enabled = values.get("enabled");
  if (enabled === "0") {
    return {
      enabled: false,
      reason: values.get("reason") || "no reason returned",
    };
  }
  if (enabled !== "1") throw new Error("missing enabled status");

  const env: Record<string, string> = {};
  for (const [key, value] of values) {
    if (key === "enabled") continue;
    if (!CONTEXT_ENV_KEYS.has(key) || value === "") {
      throw new Error(`invalid context environment entry: ${key}`);
    }
    env[key] = value;
  }
  for (const key of REQUIRED_CONTEXT_ENV_KEYS) {
    if (!(key in env)) throw new Error(`missing context environment: ${key}`);
  }
  if (!/^[0-9a-f]{32}$/.test(env.ARK_SESSION_ID)) {
    throw new Error("invalid ARK_SESSION_ID");
  }
  return { enabled: true, env };
}

export class ArkContextHarness {
  private readonly scriptDirectory: string;
  private readonly timeoutMs: number;
  private readonly ownerPid: number;
  private readonly readSetting: (key: string) => unknown;
  private readonly logger: Logger;

  constructor(options: ArkContextHarnessOptions = {}) {
    this.scriptDirectory = options.scriptDirectory ?? resolveScriptDirectory();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.ownerPid = options.ownerPid ?? process.pid;
    this.readSetting = options.readSetting ?? (key => db.getSetting(key));
    this.logger = options.logger ?? console;
  }

  async initializeSession(
    worktreePath: string,
    restartSessionId?: string
  ): Promise<Record<string, string> | undefined> {
    if (this.readSetting(ARK_CONTEXT_ENABLED_SETTING_KEY) !== true) {
      return undefined;
    }

    const args = [
      join(this.scriptDirectory, "session-init.sh"),
      "--repo",
      worktreePath,
      "--owner-pid",
      String(this.ownerPid),
    ];
    if (restartSessionId) args.push("--restart", restartSessionId);

    try {
      const { stdout } = await execFileAsync("/bin/bash", args, {
        encoding: "utf8",
        timeout: this.timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
      });
      const parsed = parseInitOutput(stdout);
      if (!parsed.enabled) {
        this.logger.warn(
          `[ArkContext] session init disabled for ${worktreePath}: ${parsed.reason}`
        );
        return undefined;
      }
      return parsed.env;
    } catch (error) {
      this.logger.error(
        `[ArkContext] session init failed for ${worktreePath}: ${getErrorMessage(error)}`
      );
      return undefined;
    }
  }

  async teardownSession(
    worktreePath: string,
    contextSessionId: string
  ): Promise<void> {
    await execFileAsync(
      "/bin/bash",
      [
        join(this.scriptDirectory, "session-teardown.sh"),
        "--repo",
        worktreePath,
        "--session-id",
        contextSessionId,
      ],
      {
        encoding: "utf8",
        timeout: this.timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
      }
    );
  }
}

export const arkContextHarness = new ArkContextHarness();
