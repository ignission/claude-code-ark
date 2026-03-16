import { execSync } from "child_process";

export interface ListeningPort {
  port: number;
  process: string;
  pid: number;
}

/**
 * システムでリッスン中のポートを取得
 * ttydポート（7680-7780）は除外
 * macOSではlsof、Linuxではssコマンドを使用
 */
export function getListeningPorts(): ListeningPort[] {
  if (process.platform === "darwin") {
    return getListeningPortsMacOS();
  }
  return getListeningPortsLinux();
}

/**
 * macOS向け: lsofを使用してリッスン中のポートを取得
 */
function getListeningPortsMacOS(): ListeningPort[] {
  try {
    // lsofコマンドは固定文字列のため、シェルインジェクションのリスクなし
    const output = execSync("lsof -i -P -n | grep LISTEN", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    const ports: ListeningPort[] = [];
    const lines = output.trim().split("\n");

    for (const line of lines) {
      // 例: "node 83337 user 22u IPv4 ... *:3001 (LISTEN)"
      const parts = line.split(/\s+/);
      if (parts.length < 9) continue;

      const process = parts[0];
      const pid = parseInt(parts[1], 10);
      const address = parts[8]; // "*:3001" or "127.0.0.1:3001"

      // ポート番号を抽出
      const portMatch = address.match(/:(\d+)$/);
      if (!portMatch) continue;

      const port = parseInt(portMatch[1], 10);

      // ttydポート（7680-7780）を除外
      if (port >= 7680 && port <= 7780) continue;

      // 重複を避ける
      if (!ports.some((p) => p.port === port)) {
        ports.push({ port, process, pid });
      }
    }

    // ポート番号でソート
    return ports.sort((a, b) => a.port - b.port);
  } catch {
    return [];
  }
}

/**
 * Linux向け: ss -tlnpを使用してリッスン中のポートを取得
 *
 * ssの出力例:
 *   State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process
 *   LISTEN 0      511                *:3001             *:*    users:(("node /home/admi",pid=8325,fd=25))
 *   LISTEN 0      4096         0.0.0.0:5433       0.0.0.0:*
 *
 * Local Addressの形式:
 *   127.0.0.1:PORT, 0.0.0.0:PORT, *:PORT, [::]:PORT, 127.0.0.53%lo:53 など
 *
 * Processカラムがない行もある（権限不足でプロセス情報が取得できない場合）
 * プロセス名にスペースや括弧を含む場合がある（例: "next-server (v1"）
 */
function getListeningPortsLinux(): ListeningPort[] {
  try {
    // ssコマンドは固定文字列のため、シェルインジェクションのリスクなし
    const output = execSync("ss -tlnp", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    const ports: ListeningPort[] = [];
    const lines = output.trim().split("\n");

    // 1行目はヘッダーなのでスキップ
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line.startsWith("LISTEN")) continue;

      // 空白で分割してカラムを取得
      // columns: [State, Recv-Q, Send-Q, Local Address:Port, Peer Address:Port, ...]
      const columns = line.split(/\s+/);
      if (columns.length < 5) continue;

      const localAddr = columns[3];

      // ポート番号を抽出（最後の:以降の数字）
      // 形式例: "127.0.0.1:20242", "0.0.0.0:5433", "*:3001", "[::]:3001", "127.0.0.53%lo:53"
      const portMatch = localAddr.match(/:(\d+)$/);
      if (!portMatch) continue;

      const port = parseInt(portMatch[1], 10);

      // ttydポート（7680-7780）を除外
      if (port >= 7680 && port <= 7780) continue;

      // プロセス情報を抽出
      // 形式: users:(("プロセス名",pid=NNN,fd=NN))
      // プロセス名にスペースや括弧が含まれる場合があるため、pid=の手前までを名前として取得
      let processName = "unknown";
      let pid = 0;

      const usersMatch = line.match(
        /users:\(\("(.+?)",pid=(\d+),fd=\d+\)\)/,
      );
      if (usersMatch) {
        processName = usersMatch[1];
        pid = parseInt(usersMatch[2], 10);
      }

      // 重複を避ける
      if (!ports.some((p) => p.port === port)) {
        ports.push({ port, process: processName, pid });
      }
    }

    // ポート番号でソート
    return ports.sort((a, b) => a.port - b.port);
  } catch {
    return [];
  }
}
