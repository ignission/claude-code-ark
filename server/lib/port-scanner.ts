import { execSync } from "node:child_process";
import {
  CDP_PORT,
  TTYD_PORT_END,
  TTYD_PORT_START,
  VNC_PORT_END,
  VNC_PORT_START,
  WS_PORT_END,
  WS_PORT_START,
} from "./constants.js";

export interface ListeningPort {
  port: number;
  process: string;
  pid: number;
}

/** 行パーサーの戻り値型 */
interface ParsedLine {
  port: number;
  processName: string;
  pid: number;
}

/**
 * システムでリッスン中のポートを取得
 * ttydポート（TTYD_PORT_START-TTYD_PORT_END）は除外
 * macOSではlsof、Linuxではssコマンドを使用
 */
export function getListeningPorts(): ListeningPort[] {
  const command =
    process.platform === "darwin" ? "lsof -i -P -n | grep LISTEN" : "ss -tlnp";
  const parseLine = process.platform === "darwin" ? parseLsofLine : parseSsLine;
  return collectPorts(command, parseLine);
}

/**
 * コマンド出力からポート一覧を収集する共通処理
 */
function collectPorts(
  command: string,
  parseLine: (line: string) => ParsedLine | null
): ListeningPort[] {
  try {
    const output = execSync(command, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    const ports: ListeningPort[] = [];
    const seen = new Set<number>();

    for (const line of output.trim().split("\n")) {
      const parsed = parseLine(line);
      if (!parsed) continue;

      const { port, processName, pid } = parsed;

      // ttyd/VNC/WebSocket/CDPポートを除外（内部用ポートのため表示しない）
      if (port === CDP_PORT) continue;
      if (port >= TTYD_PORT_START && port <= TTYD_PORT_END) continue;
      if (port >= VNC_PORT_START && port <= VNC_PORT_END) continue;
      if (port >= WS_PORT_START && port <= WS_PORT_END) continue;

      if (!seen.has(port)) {
        seen.add(port);
        ports.push({ port, process: processName, pid });
      }
    }

    return ports.sort((a, b) => a.port - b.port);
  } catch {
    return [];
  }
}

/**
 * macOS lsof出力の1行をパース
 * 例: "node 83337 user 22u IPv4 ... *:3001 (LISTEN)"
 */
function parseLsofLine(line: string): ParsedLine | null {
  const parts = line.split(/\s+/);
  if (parts.length < 9) return null;

  const processName = parts[0];
  const pid = parseInt(parts[1], 10);
  const address = parts[8]; // "*:3001" or "127.0.0.1:3001"

  const portMatch = address.match(/:(\d+)$/);
  if (!portMatch) return null;

  return { port: parseInt(portMatch[1], 10), processName, pid };
}

/**
 * Linux ss -tlnp出力の1行をパース
 *
 * 出力例:
 *   LISTEN 0 511 *:3001 *:* users:(("node /home/admi",pid=8325,fd=25))
 *   LISTEN 0 4096 0.0.0.0:5433 0.0.0.0:*
 *
 * Processカラムがない行もある（権限不足の場合）
 * プロセス名にスペースや括弧を含む場合がある（例: "next-server (v1"）
 */
function parseSsLine(line: string): ParsedLine | null {
  if (!line.startsWith("LISTEN")) return null;

  const columns = line.split(/\s+/);
  if (columns.length < 5) return null;

  const localAddr = columns[3];

  // ポート番号を抽出（最後の:以降の数字）
  // 形式例: "127.0.0.1:20242", "0.0.0.0:5433", "*:3001", "[::]:3001", "127.0.0.53%lo:53"
  const portMatch = localAddr.match(/:(\d+)$/);
  if (!portMatch) return null;

  // プロセス情報を抽出
  // 形式: users:(("プロセス名",pid=NNN,fd=NN))
  let processName = "unknown";
  let pid = 0;

  const usersMatch = line.match(/users:\(\("(.+?)",pid=(\d+),fd=\d+\)\)/);
  if (usersMatch) {
    processName = usersMatch[1];
    pid = parseInt(usersMatch[2], 10);
  }

  return { port: parseInt(portMatch[1], 10), processName, pid };
}
