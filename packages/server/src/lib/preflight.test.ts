import { describe, expect, it, vi } from "vitest";
import {
  installHint,
  nodeVersionProblem,
  type PreflightDeps,
  runPreflight,
} from "./preflight.js";

function makeDeps(overrides: Partial<PreflightDeps> = {}): PreflightDeps {
  return {
    platform: "linux",
    arch: "x64",
    dataDir: "/data",
    ttydOverride: undefined,
    resolveTmux: () => "/usr/bin/tmux",
    resolveClaude: () => "/pkg/claude",
    findOnPath: name => (name === "ttyd" ? "/usr/bin/ttyd" : null),
    fileExists: () => false,
    downloadTtyd: vi.fn(async (destDir: string) => `${destDir}/ttyd`),
    log: () => {},
    ...overrides,
  };
}

describe("nodeVersionProblem", () => {
  it("22.12 以上は通す", () => {
    expect(nodeVersionProblem("22.12.0")).toBeNull();
    expect(nodeVersionProblem("24.1.0")).toBeNull();
  });

  it("22.12 未満は、いまの版を添えて伝える", () => {
    expect(nodeVersionProblem("22.11.0")).toContain("22.11.0");
    expect(nodeVersionProblem("20.19.0")).toContain("22.12");
  });
});

describe("installHint", () => {
  it("macOS は brew を案内する", () => {
    expect(installHint("tmux", "darwin", () => false)).toBe(
      "brew install tmux"
    );
    expect(installHint("ttyd", "darwin", () => false)).toBe(
      "brew install ttyd"
    );
  });

  it("Linux の tmux は、その機械のパッケージマネージャで案内する", () => {
    expect(
      installHint("tmux", "linux", name => name === "dnf" || name === "sudo")
    ).toBe("sudo dnf install -y tmux");
  });

  it("sudo が無い機械では sudo を付けない", () => {
    expect(installHint("tmux", "linux", name => name === "apt-get")).toBe(
      "apt-get install -y tmux"
    );
  });

  it("パッケージマネージャが分からなければ入手先を案内する", () => {
    expect(installHint("tmux", "linux", () => false)).toMatch(/^https:/);
  });
});

describe("runPreflight", () => {
  it("すべて揃っていれば何もしない", async () => {
    const deps = makeDeps();
    expect(await runPreflight(deps)).toEqual({ ttydPath: null, problems: [] });
    expect(deps.downloadTtyd).not.toHaveBeenCalled();
  });

  it("ttyd が無い Linux では取得し、置いた場所を返す", async () => {
    const deps = makeDeps({ findOnPath: () => null });
    expect(await runPreflight(deps)).toEqual({
      ttydPath: "/data/bin/ttyd",
      problems: [],
    });
    expect(deps.downloadTtyd).toHaveBeenCalledOnce();
  });

  it("前に取得した ttyd があれば取得し直さない", async () => {
    const deps = makeDeps({
      findOnPath: () => null,
      fileExists: file => file === "/data/bin/ttyd",
    });
    expect((await runPreflight(deps)).ttydPath).toBe("/data/bin/ttyd");
    expect(deps.downloadTtyd).not.toHaveBeenCalled();
  });

  it("ARK_TTYD_PATH の指定があれば取得しない", async () => {
    const deps = makeDeps({
      findOnPath: () => null,
      ttydOverride: "/opt/ttyd",
    });
    expect(await runPreflight(deps)).toEqual({ ttydPath: null, problems: [] });
    expect(deps.downloadTtyd).not.toHaveBeenCalled();
  });

  it("公式バイナリが無い機械では、入れ方を伝えて止める", async () => {
    const deps = makeDeps({ platform: "darwin", findOnPath: () => null });
    const result = await runPreflight(deps);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain("brew install ttyd");
    expect(deps.downloadTtyd).not.toHaveBeenCalled();
  });

  it("取得に失敗したら、理由と入手先を伝えて止める", async () => {
    const deps = makeDeps({
      findOnPath: () => null,
      downloadTtyd: async () => {
        throw new Error("HTTP 503");
      },
    });
    const result = await runPreflight(deps);
    expect(result.ttydPath).toBeNull();
    expect(result.problems[0]).toContain("HTTP 503");
    expect(result.problems[0]).toContain("https://");
  });

  it("欠けているものは1回でまとめて伝える", async () => {
    const deps = makeDeps({
      platform: "darwin",
      resolveTmux: () => null,
      resolveClaude: () => null,
      findOnPath: () => null,
    });
    const { problems } = await runPreflight(deps);
    expect(problems).toHaveLength(3);
    expect(problems[0]).toContain("brew install tmux");
    expect(problems[2]).toContain("claude");
  });
});
