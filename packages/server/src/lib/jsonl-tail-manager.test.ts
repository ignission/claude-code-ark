/**
 * JsonlTailManager の単体テスト。
 *
 * fs を絡めるため os.tmpdir() 配下に一時ディレクトリを作って実ファイルで
 * 検証する。fs.watch のイベント発火は OS 依存でテスト不安定なので、
 * polling 経由で動く部分 (1 秒間隔の自動 drain / 自己回復) を待ち合わせる方針。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearCwdCache, encodeProjectDir } from "./claude-projects.js";
import { JsonlTailManager } from "./jsonl-tail-manager.js";

describe("JsonlTailManager", () => {
  let baseDir: string;
  let configDir: string;
  let manager: JsonlTailManager;

  // 各テストで CLAUDE_CONFIG_DIR 相当の一時ディレクトリを切り出し、
  // その配下に projects/<encoded-cwd>/ を作って .jsonl を置く。
  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ark-jsonl-test-"));
    configDir = baseDir;
    manager = new JsonlTailManager();
    clearCwdCache();
  });

  afterEach(() => {
    manager.cleanup();
    try {
      fs.rmSync(baseDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  function setupEncodedDir(worktreePath: string): string {
    const dir = path.join(
      configDir,
      "projects",
      encodeProjectDir(worktreePath)
    );
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  describe("readCurrentSnapshot", () => {
    it("encoded ディレクトリが無いケースは空配列", () => {
      const snap = manager.readCurrentSnapshot("/no/such/worktree", configDir);
      expect(snap).toEqual([]);
    });

    it("最新の .jsonl から末尾行を limit 件読む", () => {
      const wt = "/wt/proj_a";
      const dir = setupEncodedDir(wt);
      const file = path.join(dir, "session1.jsonl");
      const lines = ['{"a":1}', '{"a":2}', '{"a":3}'];
      fs.writeFileSync(file, `${lines.join("\n")}\n`);

      const snap = manager.readCurrentSnapshot(wt, configDir, 100);
      expect(snap.map(l => l.raw)).toEqual(lines);
      expect(snap[0].parsed).toEqual({ a: 1 });
      expect(snap[0].filePath).toBe(file);
    });

    it("limit より多い行があれば末尾 limit 件だけ返す", () => {
      const wt = "/wt/proj_b";
      const dir = setupEncodedDir(wt);
      const file = path.join(dir, "s.jsonl");
      const all = Array.from({ length: 50 }, (_, i) => `{"i":${i}}`);
      fs.writeFileSync(file, `${all.join("\n")}\n`);

      const snap = manager.readCurrentSnapshot(wt, configDir, 10);
      expect(snap).toHaveLength(10);
      expect(snap[0].raw).toBe('{"i":40}');
      expect(snap[9].raw).toBe('{"i":49}');
    });

    it("mtime 最新の .jsonl ファイルが選ばれる", () => {
      const wt = "/wt/proj_c";
      const dir = setupEncodedDir(wt);
      const older = path.join(dir, "old.jsonl");
      const newer = path.join(dir, "new.jsonl");
      fs.writeFileSync(older, '{"label":"old"}\n');
      // mtime 差を確実に出すため明示的に過去日時にする
      const past = new Date(Date.now() - 60_000);
      fs.utimesSync(older, past, past);
      fs.writeFileSync(newer, '{"label":"new"}\n');

      const snap = manager.readCurrentSnapshot(wt, configDir);
      expect(snap[0].parsed).toEqual({ label: "new" });
      expect(snap[0].filePath).toBe(newer);
    });

    it("cwd 不一致の最新ファイルより cwd 一致ファイルを優先する (encode 衝突対策)", () => {
      const wt = "/wt/proj_cd";
      const dir = setupEncodedDir(wt);
      const mine = path.join(dir, "mine.jsonl");
      const other = path.join(dir, "other.jsonl");
      fs.writeFileSync(mine, `{"cwd":"${wt}","label":"mine"}\n`);
      const past = new Date(Date.now() - 60_000);
      fs.utimesSync(mine, past, past);
      // encode が衝突する別 cwd の transcript (mtime はこちらが新しい)
      fs.writeFileSync(other, '{"cwd":"/wt/proj.cd","label":"other"}\n');

      const snap = manager.readCurrentSnapshot(wt, configDir);
      expect(snap[0].parsed).toEqual({ cwd: wt, label: "mine" });
    });

    it("不正な JSON 行も raw として返し parsed は undefined", () => {
      const wt = "/wt/proj_d";
      const dir = setupEncodedDir(wt);
      const file = path.join(dir, "s.jsonl");
      fs.writeFileSync(file, "not json\n");

      const snap = manager.readCurrentSnapshot(wt, configDir);
      expect(snap[0].raw).toBe("not json");
      expect(snap[0].parsed).toBeUndefined();
    });
  });

  describe("subscribe で追記行を listener に通知する", () => {
    it("subscribe 後にファイルへ追記した行が onLine で届く", async () => {
      const wt = "/wt/proj_e";
      const dir = setupEncodedDir(wt);
      const file = path.join(dir, "s.jsonl");
      fs.writeFileSync(file, '{"seq":1}\n');

      const lines: string[] = [];
      const unsub = manager.subscribe(wt, configDir, {
        onLine: line => {
          lines.push(line.raw);
        },
      });

      // subscribe は末尾までシークしているので 既存の {"seq":1} は流れない。
      // 追記した分だけが届く想定。
      fs.appendFileSync(file, '{"seq":2}\n{"seq":3}\n');
      // 1 秒間隔の polling を 1 回以上待つ
      await new Promise(r => setTimeout(r, 1300));

      expect(lines).toEqual(['{"seq":2}', '{"seq":3}']);
      unsub();
    });

    it("既存ファイル末尾の改行未完了行は次回追記で連結して処理される", async () => {
      const wt = "/wt/proj_f";
      const dir = setupEncodedDir(wt);
      const file = path.join(dir, "s.jsonl");
      fs.writeFileSync(file, "");

      const lines: string[] = [];
      const unsub = manager.subscribe(wt, configDir, {
        onLine: line => lines.push(line.raw),
      });

      // 改行で終わっていない断片 → polling では未確定として保留される
      fs.appendFileSync(file, '{"part":');
      await new Promise(r => setTimeout(r, 1300));
      expect(lines).toEqual([]);

      // 改行が来てはじめて確定行として通知される
      fs.appendFileSync(file, "1}\n");
      await new Promise(r => setTimeout(r, 1300));
      expect(lines).toEqual(['{"part":1}']);

      unsub();
    });
  });

  describe("dir / file が購読後に出現するケース (自己回復)", () => {
    it("subscribe 時に encoded ディレクトリが無くても、後から作られた .jsonl を拾う", async () => {
      const wt = "/wt/proj_late_dir";
      // setupEncodedDir をあえて呼ばず、dir 不在のまま購読する
      const lines: string[] = [];
      let resets = 0;
      const unsub = manager.subscribe(wt, configDir, {
        onLine: line => lines.push(line.raw),
        onReset: () => {
          resets++;
        },
      });

      await new Promise(r => setTimeout(r, 200));
      // Claude Code 初回起動相当: dir + .jsonl が後から出現
      const dir = setupEncodedDir(wt);
      const file = path.join(dir, "s.jsonl");
      fs.writeFileSync(file, '{"first":1}\n');

      // polling の自己回復 (1 秒間隔) を待つ
      await new Promise(r => setTimeout(r, 1500));

      // 新規出現ファイルは先頭から読まれる
      expect(lines).toEqual(['{"first":1}']);
      // 初回発見は「切替」ではないので onReset は不要
      expect(resets).toBe(0);
      unsub();
    });

    it("subscribe 時に dir はあるが .jsonl が無くても、後から作られたファイルを拾う", async () => {
      const wt = "/wt/proj_late_file";
      const dir = setupEncodedDir(wt);

      const lines: string[] = [];
      const unsub = manager.subscribe(wt, configDir, {
        onLine: line => lines.push(line.raw),
      });

      await new Promise(r => setTimeout(r, 200));
      const file = path.join(dir, "s.jsonl");
      fs.writeFileSync(file, '{"hello":1}\n');

      await new Promise(r => setTimeout(r, 1500));
      expect(lines).toEqual(['{"hello":1}']);
      unsub();
    });
  });

  describe("ファイル切替 (/clear 相当) で onReset コールバックが呼ばれる", () => {
    it("ディレクトリに新規 .jsonl が出現すると onReset 発火、以降は新ファイルから", async () => {
      const wt = "/wt/proj_g";
      const dir = setupEncodedDir(wt);
      const file1 = path.join(dir, "s1.jsonl");
      fs.writeFileSync(file1, '{"old":1}\n');

      const lines: string[] = [];
      let resetCount = 0;
      const unsub = manager.subscribe(wt, configDir, {
        onLine: line => lines.push(line.raw),
        onReset: () => {
          resetCount++;
          // onReset の時点では旧履歴は破棄されている想定なので、
          // 受信ログもクリアしてあとに来る new ファイル行だけが残るか確認しやすくする
          lines.length = 0;
        },
      });

      // mtime 差を確実に出すため file1 を過去時刻に
      const past = new Date(Date.now() - 60_000);
      fs.utimesSync(file1, past, past);

      // 新セッション開始相当: 新しい .jsonl がディレクトリに登場
      const file2 = path.join(dir, "s2.jsonl");
      fs.writeFileSync(file2, '{"new":1}\n');

      // dirWatcher + polling の発火を待つ
      await new Promise(r => setTimeout(r, 1500));

      expect(resetCount).toBeGreaterThanOrEqual(1);
      expect(lines).toEqual(['{"new":1}']);

      unsub();
    });
  });

  describe("unsubscribe", () => {
    it("最後の listener が外れたら tail を停止して、以降の追記は流れない", async () => {
      const wt = "/wt/proj_h";
      const dir = setupEncodedDir(wt);
      const file = path.join(dir, "s.jsonl");
      fs.writeFileSync(file, "");

      const lines: string[] = [];
      const unsub = manager.subscribe(wt, configDir, {
        onLine: line => lines.push(line.raw),
      });

      fs.appendFileSync(file, '{"a":1}\n');
      await new Promise(r => setTimeout(r, 1300));
      expect(lines).toHaveLength(1);

      unsub();

      // unsubscribe 後の追記は届かないはず
      fs.appendFileSync(file, '{"a":2}\n');
      await new Promise(r => setTimeout(r, 1300));
      expect(lines).toHaveLength(1);
    });

    it("同一 worktree を複数 listener で購読し、片方解除しても残った listener には届く", async () => {
      const wt = "/wt/proj_i";
      const dir = setupEncodedDir(wt);
      const file = path.join(dir, "s.jsonl");
      fs.writeFileSync(file, "");

      const a: string[] = [];
      const b: string[] = [];
      const unsubA = manager.subscribe(wt, configDir, {
        onLine: line => a.push(line.raw),
      });
      const unsubB = manager.subscribe(wt, configDir, {
        onLine: line => b.push(line.raw),
      });

      fs.appendFileSync(file, '{"x":1}\n');
      await new Promise(r => setTimeout(r, 1300));
      expect(a).toEqual(['{"x":1}']);
      expect(b).toEqual(['{"x":1}']);

      unsubA();

      fs.appendFileSync(file, '{"x":2}\n');
      await new Promise(r => setTimeout(r, 1300));
      expect(a).toEqual(['{"x":1}']); // 解除済みは増えない
      expect(b).toEqual(['{"x":1}', '{"x":2}']);

      unsubB();
    });
  });
});
