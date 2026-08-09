import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DIAGRAM_COMMENTS_MAX_ANCHOR_OR_ID_LENGTH,
  DIAGRAM_COMMENTS_MAX_AUTHOR_LENGTH,
  DIAGRAM_COMMENTS_MAX_BODY_LENGTH,
  DIAGRAM_COMMENTS_MAX_BYTES,
  DIAGRAM_COMMENTS_MAX_THREADS,
  parseDiagramComments,
  readDiagramCommentsFile,
  resolveDiagramCommentsPath,
} from "./diagram-comments.js";

let worktree: string;

beforeEach(() => {
  worktree = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "ark-diagram-comments-"))
  );
  fs.mkdirSync(path.join(worktree, ".claude/diagrams"), { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(worktree, { recursive: true, force: true });
});

const target = "order-flow.diagram.html";
const timestamp = "2026-08-09T01:02:03.456Z";

function comments(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    target,
    threads: [
      {
        id: "th-1",
        anchorId: "s1-p1",
        anchorText: "注文を受け付ける",
        status: "open",
        createdAt: timestamp,
        messages: [
          {
            id: "m-1",
            author: "Reviewer",
            at: timestamp,
            body: "確認してください",
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe("resolveDiagramCommentsPath", () => {
  it("図から同じ階層の sidecar と basename target を導出する", () => {
    const result = resolveDiagramCommentsPath(
      worktree,
      ".claude/diagrams/review/order-flow.diagram.html"
    );

    expect(result).toEqual({
      ok: true,
      diagramAbsPath: path.join(
        worktree,
        ".claude/diagrams/review/order-flow.diagram.html"
      ),
      commentsAbsPath: path.join(
        worktree,
        ".claude/diagrams/review/order-flow.comments.json"
      ),
      diagramRelPath: ".claude/diagrams/review/order-flow.diagram.html",
      target,
    });
  });

  it.each([
    "/tmp/order-flow.diagram.html",
    "../order-flow.diagram.html",
    ".claude/diagrams/order-flow.html",
    ".claude/diagrams/order-flow.diagram.html\0suffix",
    `${"a".repeat(1025)}.diagram.html`,
  ])("不正な図 path %j を拒否する", relPath => {
    expect(resolveDiagramCommentsPath(worktree, relPath).ok).toBe(false);
  });
});

describe("parseDiagramComments", () => {
  it("厳格 schema に合う sidecar を返す", () => {
    expect(parseDiagramComments(JSON.stringify(comments()), target)).toEqual({
      ok: true,
      comments: comments(),
    });
  });

  it.each([
    ["壊れた JSON", "{"],
    ["version 違い", JSON.stringify(comments({ version: 2 }))],
    [
      "target 不一致",
      JSON.stringify(comments({ target: "other.diagram.html" })),
    ],
    ["threads が配列でない", JSON.stringify(comments({ threads: {} }))],
    [
      "messages が空",
      JSON.stringify(
        comments({
          threads: [{ ...comments().threads[0], messages: [] }],
        })
      ),
    ],
    [
      "anchor が空",
      JSON.stringify(
        comments({ threads: [{ ...comments().threads[0], anchorId: "" }] })
      ),
    ],
    [
      "author が空",
      JSON.stringify(
        comments({
          threads: [
            {
              ...comments().threads[0],
              messages: [{ ...comments().threads[0].messages[0], author: "" }],
            },
          ],
        })
      ),
    ],
    [
      "body が空",
      JSON.stringify(
        comments({
          threads: [
            {
              ...comments().threads[0],
              messages: [{ ...comments().threads[0].messages[0], body: "" }],
            },
          ],
        })
      ),
    ],
    [
      "createdAt が ISO timestamp でない",
      JSON.stringify(
        comments({
          threads: [{ ...comments().threads[0], createdAt: "2026/08/09" }],
        })
      ),
    ],
    [
      "message at が ISO timestamp でない",
      JSON.stringify(
        comments({
          threads: [
            {
              ...comments().threads[0],
              messages: [{ ...comments().threads[0].messages[0], at: "today" }],
            },
          ],
        })
      ),
    ],
    [
      "status が orphaned",
      JSON.stringify(
        comments({
          threads: [{ ...comments().threads[0], status: "orphaned" }],
        })
      ),
    ],
  ])("%s は INVALID_SIDECAR", (_name, raw) => {
    const result = parseDiagramComments(raw, target);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_SIDECAR");
  });

  it("thread と message の ID を sidecar 全体で一意にする", () => {
    const first = comments().threads[0];
    const duplicateThread = {
      ...first,
      anchorId: "s2",
      messages: [{ ...first.messages[0], id: "m-2" }],
    };
    const duplicateMessage = {
      ...first,
      id: "th-2",
      anchorId: "s3",
      messages: [{ ...first.messages[0] }],
    };
    const crossKindDuplicate = {
      ...first,
      id: "th-3",
      anchorId: "s4",
      messages: [{ ...first.messages[0], id: "th-3" }],
    };

    for (const threads of [
      [first, duplicateThread],
      [first, duplicateMessage],
      [first, crossKindDuplicate],
    ]) {
      const result = parseDiagramComments(
        JSON.stringify(comments({ threads })),
        target
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("INVALID_SIDECAR");
    }
  });

  it("各上限の境界値を受け付ける", () => {
    const thread = comments().threads[0];
    const boundary = comments({
      threads: [
        {
          ...thread,
          id: "t".repeat(DIAGRAM_COMMENTS_MAX_ANCHOR_OR_ID_LENGTH),
          anchorId: "a".repeat(DIAGRAM_COMMENTS_MAX_ANCHOR_OR_ID_LENGTH),
          anchorText: "x".repeat(DIAGRAM_COMMENTS_MAX_ANCHOR_OR_ID_LENGTH),
          messages: [
            {
              ...thread.messages[0],
              id: "m".repeat(DIAGRAM_COMMENTS_MAX_ANCHOR_OR_ID_LENGTH),
              author: "a".repeat(DIAGRAM_COMMENTS_MAX_AUTHOR_LENGTH),
              body: "b".repeat(DIAGRAM_COMMENTS_MAX_BODY_LENGTH),
            },
          ],
        },
      ],
    });

    expect(parseDiagramComments(JSON.stringify(boundary), target).ok).toBe(
      true
    );
  });

  it("threads/文字列/byte size の上限超過を拒否する", () => {
    const thread = comments().threads[0];
    const cases = [
      comments({
        threads: Array.from(
          { length: DIAGRAM_COMMENTS_MAX_THREADS + 1 },
          (_, index) => ({
            ...thread,
            id: `th-${index}`,
            messages: [{ ...thread.messages[0], id: `m-${index}` }],
          })
        ),
      }),
      comments({
        threads: [
          {
            ...thread,
            anchorId: "a".repeat(DIAGRAM_COMMENTS_MAX_ANCHOR_OR_ID_LENGTH + 1),
          },
        ],
      }),
      comments({
        threads: [
          {
            ...thread,
            messages: [
              {
                ...thread.messages[0],
                author: "a".repeat(DIAGRAM_COMMENTS_MAX_AUTHOR_LENGTH + 1),
              },
            ],
          },
        ],
      }),
      comments({
        threads: [
          {
            ...thread,
            messages: [
              {
                ...thread.messages[0],
                body: "b".repeat(DIAGRAM_COMMENTS_MAX_BODY_LENGTH + 1),
              },
            ],
          },
        ],
      }),
    ];

    for (const value of cases) {
      expect(parseDiagramComments(JSON.stringify(value), target).ok).toBe(
        false
      );
    }
    expect(
      parseDiagramComments(" ".repeat(DIAGRAM_COMMENTS_MAX_BYTES + 1), target)
        .ok
    ).toBe(false);
  });
});

describe("readDiagramCommentsFile", () => {
  const relPath = ".claude/diagrams/order-flow.diagram.html";

  it("sidecar 未存在は disk に作成せず空 snapshot を返す", async () => {
    const sidecar = path.join(
      worktree,
      ".claude/diagrams/order-flow.comments.json"
    );

    await expect(readDiagramCommentsFile(worktree, relPath)).resolves.toEqual({
      ok: true,
      comments: { version: 1, target, threads: [] },
    });
    expect(fs.existsSync(sidecar)).toBe(false);
  });

  it("正常な sidecar の snapshot を返す", async () => {
    fs.writeFileSync(
      path.join(worktree, ".claude/diagrams/order-flow.comments.json"),
      JSON.stringify(comments())
    );

    await expect(readDiagramCommentsFile(worktree, relPath)).resolves.toEqual({
      ok: true,
      comments: comments(),
    });
  });

  it.each([
    ["壊れた JSON", "{"],
    [
      "target 不一致",
      JSON.stringify(comments({ target: "other.diagram.html" })),
    ],
    ["oversize", " ".repeat(DIAGRAM_COMMENTS_MAX_BYTES + 1)],
  ])("%s を空 snapshot にせず明示 error にする", async (_name, raw) => {
    fs.writeFileSync(
      path.join(worktree, ".claude/diagrams/order-flow.comments.json"),
      raw
    );

    const result = await readDiagramCommentsFile(worktree, relPath);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_SIDECAR");
  });

  it("EACCES を空 snapshot にせず errno 付き IO_ERROR にする", async () => {
    const sidecar = path.join(
      worktree,
      ".claude/diagrams/order-flow.comments.json"
    );
    fs.writeFileSync(sidecar, JSON.stringify(comments()));
    fs.chmodSync(sidecar, 0o000);

    try {
      const result = await readDiagramCommentsFile(worktree, relPath);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("IO_ERROR");
        expect(result.error).toContain("EACCES");
      }
    } finally {
      fs.chmodSync(sidecar, 0o644);
    }
  });

  it("worktree 外を指す symlink を拒否する", async () => {
    const outside = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "ark-comments-outside-"))
    );
    const outsideSidecar = path.join(outside, "order-flow.comments.json");
    fs.writeFileSync(outsideSidecar, JSON.stringify(comments()));
    fs.symlinkSync(
      outsideSidecar,
      path.join(worktree, ".claude/diagrams/order-flow.comments.json")
    );

    try {
      const result = await readDiagramCommentsFile(worktree, relPath);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("FORBIDDEN");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("open 後に inode/device が一致しなければ拒否する", async () => {
    const sidecar = path.join(
      worktree,
      ".claude/diagrams/order-flow.comments.json"
    );
    fs.writeFileSync(sidecar, JSON.stringify(comments()));
    const stat = fs.promises.stat.bind(fs.promises);
    vi.spyOn(fs.promises, "stat").mockImplementation(async (...args) => {
      const result = await stat(...args);
      return Object.assign(result, { ino: result.ino + 1 });
    });

    const result = await readDiagramCommentsFile(worktree, relPath);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("FORBIDDEN");
  });

  it("sidecar path が directory なら拒否する", async () => {
    fs.mkdirSync(
      path.join(worktree, ".claude/diagrams/order-flow.comments.json")
    );

    const result = await readDiagramCommentsFile(worktree, relPath);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("FORBIDDEN");
  });

  it.each([
    ["成功", JSON.stringify(comments())],
    ["parse 失敗", "{"],
  ])("%s の経路で file handle を close する", async (_name, raw) => {
    const sidecar = path.join(
      worktree,
      ".claude/diagrams/order-flow.comments.json"
    );
    fs.writeFileSync(sidecar, raw);
    const open = fs.promises.open.bind(fs.promises);
    const close = vi.fn();
    vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      close.mockImplementation(() => handle.close());
      return {
        stat: () => handle.stat(),
        readFile: (options?: Parameters<typeof handle.readFile>[0]) =>
          handle.readFile(options),
        close,
      } as unknown as fs.promises.FileHandle;
    });

    await readDiagramCommentsFile(worktree, relPath);

    expect(close).toHaveBeenCalledOnce();
  });
});
