/**
 * 図ファイルの更新監視。
 *
 * jsonl-tail-manager.ts と同じ方針で、fs.watch だけに頼らず 1 秒 polling を
 * 併用する。fs.watch はプラットフォームによって取りこぼし、エディタの
 * 書き換え方（rename 置換）でも watcher が外れるため。
 * 通知は mtime + size の変化を見て出す（内容の再読込は購読側の責務）。
 */

import fs from "node:fs";

interface Watched {
  listeners: Set<() => void>;
  watcher: fs.FSWatcher | null;
  pollTimer: NodeJS.Timeout | null;
  signature: string;
}

const POLL_INTERVAL_MS = 1000;

function signatureOf(absPath: string): string {
  try {
    const st = fs.statSync(absPath);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "";
  }
}

export class DiagramWatcher {
  private watched = new Map<string, Watched>();

  /** 更新通知を購読する。戻り値を呼ぶと解除する。 */
  subscribe(absPath: string, listener: () => void): () => void {
    let entry = this.watched.get(absPath);
    if (!entry) {
      entry = {
        listeners: new Set(),
        watcher: null,
        pollTimer: null,
        signature: signatureOf(absPath),
      };
      this.watched.set(absPath, entry);
      this.startWatcher(absPath, entry);
      entry.pollTimer = setInterval(() => {
        this.check(absPath);
      }, POLL_INTERVAL_MS);
    }
    entry.listeners.add(listener);

    return () => {
      const e = this.watched.get(absPath);
      if (!e) return;
      e.listeners.delete(listener);
      if (e.listeners.size === 0) this.stop(absPath);
    };
  }

  cleanup(): void {
    for (const key of [...this.watched.keys()]) this.stop(key);
  }

  private startWatcher(absPath: string, entry: Watched): void {
    try {
      const watcher = fs.watch(absPath, () => {
        this.check(absPath);
      });
      // FSWatcher は EventEmitter。error リスナーが無いと、稼働後に発生した
      // ランタイムエラー（ハンドル上限・監視対象の削除等）が uncaughtException
      // となり Ark プロセス全体を落とす。ここで受けて watcher を畳み、
      // polling 側の自己回復（次 tick で startWatcher 再試行）に委ねる。
      watcher.on("error", () => {
        try {
          watcher.close();
        } catch {
          // 既に閉じている等は無視
        }
        if (entry.watcher === watcher) entry.watcher = null;
      });
      entry.watcher = watcher;
    } catch {
      // ファイルが未作成でも polling が後から拾う
      entry.watcher = null;
    }
  }

  /** 署名が変わっていれば通知する（watch と poll の二重発火を冪等にする） */
  private check(absPath: string): void {
    const entry = this.watched.get(absPath);
    if (!entry) return;
    if (!entry.watcher) this.startWatcher(absPath, entry);
    const next = signatureOf(absPath);
    if (next === entry.signature) return;
    entry.signature = next;
    for (const l of [...entry.listeners]) {
      try {
        l();
      } catch {
        // 1 listener の例外を他へ波及させない
      }
    }
  }

  private stop(absPath: string): void {
    const entry = this.watched.get(absPath);
    if (!entry) return;
    entry.watcher?.close();
    entry.watcher = null;
    if (entry.pollTimer) {
      clearInterval(entry.pollTimer);
      entry.pollTimer = null;
    }
    this.watched.delete(absPath);
  }
}

export const diagramWatcher = new DiagramWatcher();
