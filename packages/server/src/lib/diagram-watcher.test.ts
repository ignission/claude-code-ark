/**
 * fs.watch のイベント発火は OS 依存でテストが不安定なため、
 * jsonl-tail-manager.test.ts と同じく polling 経由で動く部分を待ち合わせる。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DiagramWatcher } from "./diagram-watcher.js";

let dir: string;
let watcher: DiagramWatcher;

beforeEach(() => {
  dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "ark-diagram-watch-"))
  );
  watcher = new DiagramWatcher();
});

afterEach(() => {
  watcher.cleanup();
  fs.rmSync(dir, { recursive: true, force: true });
});

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

describe("DiagramWatcher", () => {
  it("ファイルが更新されたら listener を呼ぶ", async () => {
    const file = path.join(dir, "a.diagram.html");
    fs.writeFileSync(file, "<html>1</html>");
    let calls = 0;
    watcher.subscribe(file, () => {
      calls += 1;
    });

    await wait(50);
    fs.writeFileSync(file, "<html>2</html>");
    await wait(1600);

    expect(calls).toBeGreaterThan(0);
  });

  it("購読解除したら以後は呼ばれない", async () => {
    const file = path.join(dir, "b.diagram.html");
    fs.writeFileSync(file, "<html>1</html>");
    let calls = 0;
    const off = watcher.subscribe(file, () => {
      calls += 1;
    });
    off();

    fs.writeFileSync(file, "<html>2</html>");
    await wait(1600);

    expect(calls).toBe(0);
  });

  it("同じファイルへの複数購読は最後の解除で停止する", async () => {
    const file = path.join(dir, "c.diagram.html");
    fs.writeFileSync(file, "<html>1</html>");
    let a = 0;
    let b = 0;
    const offA = watcher.subscribe(file, () => {
      a += 1;
    });
    watcher.subscribe(file, () => {
      b += 1;
    });
    offA();

    await wait(50);
    fs.writeFileSync(file, "<html>2</html>");
    await wait(1600);

    expect(a).toBe(0);
    expect(b).toBeGreaterThan(0);
  });
});
