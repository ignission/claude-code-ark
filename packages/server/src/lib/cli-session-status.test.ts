/**
 * cli-session-status: Claude Code CLI の状態ファイルの読み取りと格上げ規則
 *
 * 1 秒間隔の polling 経路から呼ばれるので、どんな壊れ方をしても throw せず
 * 「読めない」(= null) に倒れることを中心に検証する。
 */

import { describe, expect, it, vi } from "vitest";
import {
  type CliSessionIo,
  CliSessionStatusReader,
  mergeCliSessionState,
  parseProcStartTime,
} from "./cli-session-status.js";

/** 実機 (Linux 7.0.0 / claude 2.1.273) から採取した /proc/<pid>/stat の 1 行 */
const REAL_PROC_STAT =
  "1074495 (claude) S 1074418 1074495 1074418 34832 1074495 4194304 19279321 295343967 452686 3080 522765 63670 289043 46765 20 0 13 0 162060271 7261995008 227703 18446744073709551615 24714240 88028640 281474108457008 0 0 0 0 4096 2072145151 0 0 0 17 0 0 0 0 0 0 88094176 230752256 1092562944 2814741084";

const HOME = "/home/tester";
const SESSIONS_DIR = `${HOME}/.claude/sessions`;

interface FakeWorld {
  /** ディレクトリ名 → ファイル名の一覧 */
  dirs: Record<string, string[]>;
  /** ファイルの絶対パス → 中身 */
  files: Record<string, string>;
  /** pid → /proc/<pid>/stat の中身 */
  procs: Record<number, string>;
  now: number;
}

function makeIo(world: FakeWorld, platform: NodeJS.Platform = "linux") {
  const io: CliSessionIo = {
    platform,
    homeDir: () => HOME,
    readDir: dir => {
      const entries = world.dirs[dir];
      if (!entries) {
        const error = new Error(`ENOENT: no such directory, scandir '${dir}'`);
        (error as NodeJS.ErrnoException).code = "ENOENT";
        throw error;
      }
      return entries;
    },
    readFile: file => {
      const text = world.files[file];
      if (text === undefined) {
        const error = new Error(`ENOENT: no such file, open '${file}'`);
        (error as NodeJS.ErrnoException).code = "ENOENT";
        throw error;
      }
      return text;
    },
    readProcStat: pid => world.procs[pid] ?? null,
    now: () => world.now,
  };
  return io;
}

function sessionFile(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    pid: 1074495,
    sessionId: "24cbab82-54a8-45db-9396-4357159c0fd5",
    cwd: "/repo/wt",
    startedAt: 1789598341770,
    procStart: "162060271",
    version: "2.1.273",
    kind: "interactive",
    tmux: "ark-sess-1:@20.%20",
    status: "busy",
    updatedAt: 1789728224344,
    statusUpdatedAt: 1789728224344,
    ...overrides,
  };
}

function worldWith(
  json: Record<string, unknown>,
  { dir = SESSIONS_DIR, name = "1074495.json" } = {}
): FakeWorld {
  return {
    dirs: { [dir]: [name, "1074495.abc.key"] },
    files: { [`${dir}/${name}`]: JSON.stringify(json) },
    procs: { 1074495: REAL_PROC_STAT },
    now: 1_000,
  };
}

const target = {
  tmuxSessionName: "ark-sess-1",
  worktreePath: "/repo/wt",
};

describe("parseProcStartTime", () => {
  it("実機の /proc/<pid>/stat から starttime (22 番目) を取り出す", () => {
    expect(parseProcStartTime(REAL_PROC_STAT)).toBe("162060271");
  });

  it("comm に空白や括弧が含まれていても最後の ')' で切って数える", () => {
    const stat =
      "42 (my ) proc) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 999888";
    expect(parseProcStartTime(stat)).toBe("999888");
  });

  it("形が違えば null を返す (throw しない)", () => {
    expect(parseProcStartTime("")).toBeNull();
    expect(parseProcStartTime("1074495 claude S 1 2 3")).toBeNull();
  });
});

describe("mergeCliSessionState", () => {
  it("busy のときだけ IDLE / READY を TOOL に格上げする", () => {
    expect(mergeCliSessionState("IDLE", "busy")).toBe("TOOL");
    expect(mergeCliSessionState("READY", "busy")).toBe("TOOL");
  });

  it("busy でも画面が要対応・実行中・停止なら上書きしない", () => {
    expect(mergeCliSessionState("AWAITING", "busy")).toBe("AWAITING");
    expect(mergeCliSessionState("ERR", "busy")).toBe("ERR");
    expect(mergeCliSessionState("STOP", "busy")).toBe("STOP");
    expect(mergeCliSessionState("TOOL", "busy")).toBe("TOOL");
    expect(mergeCliSessionState("THINK", "busy")).toBe("THINK");
  });

  it("waiting / idle / 不明では画面の判定をそのまま使う (降格しない)", () => {
    for (const state of ["waiting", "idle", null] as const) {
      expect(mergeCliSessionState("IDLE", state)).toBe("IDLE");
      expect(mergeCliSessionState("READY", state)).toBe("READY");
      expect(mergeCliSessionState("TOOL", state)).toBe("TOOL");
      expect(mergeCliSessionState("AWAITING", state)).toBe("AWAITING");
    }
  });
});

describe("CliSessionStatusReader.stateFor", () => {
  it("tmux セッション名と cwd が一致する busy の記録を返す", () => {
    const reader = new CliSessionStatusReader(makeIo(worldWith(sessionFile())));
    expect(reader.stateFor(target)).toBe("busy");
  });

  it("waiting / idle もそのまま返す", () => {
    for (const status of ["waiting", "idle"] as const) {
      const reader = new CliSessionStatusReader(
        makeIo(worldWith(sessionFile({ status })))
      );
      expect(reader.stateFor(target)).toBe(status);
    }
  });

  it("tmux のペイン込み識別子から ':' の前をセッション名として使う", () => {
    const reader = new CliSessionStatusReader(
      makeIo(worldWith(sessionFile({ tmux: "ark-sess-1:@20.%20" })))
    );
    expect(reader.stateFor(target)).toBe("busy");
    expect(
      reader.stateFor({ ...target, tmuxSessionName: "ark-sess-1:@20" })
    ).toBeNull();
  });

  it("cwd が worktree と違えば採用しない (取り違え防止)", () => {
    const reader = new CliSessionStatusReader(
      makeIo(worldWith(sessionFile({ cwd: "/repo/other" })))
    );
    expect(reader.stateFor(target)).toBeNull();
  });

  it("末尾スラッシュの差は同じ worktree とみなす", () => {
    const reader = new CliSessionStatusReader(
      makeIo(worldWith(sessionFile({ cwd: "/repo/wt/" })))
    );
    expect(reader.stateFor(target)).toBe("busy");
  });

  it("プロセスが死んでいれば無視する", () => {
    const world = worldWith(sessionFile());
    world.procs = {};
    const reader = new CliSessionStatusReader(makeIo(world));
    expect(reader.stateFor(target)).toBeNull();
  });

  it("starttime が食い違えば無視する (PID 使い回し)", () => {
    const world = worldWith(sessionFile({ procStart: "999999999" }));
    const reader = new CliSessionStatusReader(makeIo(world));
    expect(reader.stateFor(target)).toBeNull();
  });

  it("JSON が壊れていても他の記録は読める", () => {
    const world = worldWith(sessionFile());
    world.dirs[SESSIONS_DIR] = ["broken.json", "1074495.json"];
    world.files[`${SESSIONS_DIR}/broken.json`] = "{ not json";
    const warn = vi.fn();
    const reader = new CliSessionStatusReader(makeIo(world), { warn });
    expect(reader.stateFor(target)).toBe("busy");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("同じ壊れ方を毎 tick 警告しない", () => {
    const world = worldWith(sessionFile());
    world.dirs[SESSIONS_DIR] = ["broken.json"];
    world.files[`${SESSIONS_DIR}/broken.json`] = "{ not json";
    const warn = vi.fn();
    const reader = new CliSessionStatusReader(makeIo(world), {
      warn,
      ttlMs: 0,
    });
    reader.stateFor(target);
    reader.stateFor(target);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("形が変わって status が読めなければ無視する", () => {
    const reader = new CliSessionStatusReader(
      makeIo(worldWith(sessionFile({ status: "running" })))
    );
    expect(reader.stateFor(target)).toBeNull();
  });

  it("tmux を持たない記録 (tmux 外の claude) は無視する", () => {
    const json = sessionFile();
    delete json.tmux;
    const reader = new CliSessionStatusReader(makeIo(worldWith(json)));
    expect(reader.stateFor(target)).toBeNull();
  });

  it("ディレクトリが無ければ空として扱う", () => {
    const world = worldWith(sessionFile());
    world.dirs = {};
    const reader = new CliSessionStatusReader(makeIo(world));
    expect(reader.stateFor(target)).toBeNull();
  });

  it("Linux 以外では機構ごと無効にする (/proc で生死を確かめられない)", () => {
    const reader = new CliSessionStatusReader(
      makeIo(worldWith(sessionFile()), "darwin")
    );
    expect(reader.stateFor(target)).toBeNull();
  });

  it("プロファイルの configDir が指定されればそちらの sessions を読む", () => {
    const profileDir = "/home/tester/.claude-alt/sessions";
    const world = worldWith(sessionFile(), { dir: profileDir });
    const reader = new CliSessionStatusReader(makeIo(world));
    expect(reader.stateFor(target)).toBeNull();
    expect(
      reader.stateFor({ ...target, configDir: "/home/tester/.claude-alt" })
    ).toBe("busy");
  });

  it("TTL の内は読み直さず、超えたら読み直してセッション消滅を反映する", () => {
    const world = worldWith(sessionFile());
    const io = makeIo(world);
    const readDir = vi.spyOn(io, "readDir");
    const reader = new CliSessionStatusReader(io, { ttlMs: 2_000 });

    expect(reader.stateFor(target)).toBe("busy");
    world.dirs[SESSIONS_DIR] = [];
    world.now += 1_000;
    expect(reader.stateFor(target)).toBe("busy");
    expect(readDir).toHaveBeenCalledTimes(1);

    world.now += 2_000;
    expect(reader.stateFor(target)).toBeNull();
    expect(readDir).toHaveBeenCalledTimes(2);
  });
});
