import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDiagramComment,
  DIAGRAM_COMMENTS_MAX_ANCHOR_OR_ID_LENGTH,
  DIAGRAM_COMMENTS_MAX_ANCHOR_QUOTE_LENGTH,
  DIAGRAM_COMMENTS_MAX_AUTHOR_LENGTH,
  DIAGRAM_COMMENTS_MAX_BODY_LENGTH,
  DIAGRAM_COMMENTS_MAX_BYTES,
  DIAGRAM_COMMENTS_MAX_THREADS,
  deleteDiagramComment,
  parseDiagramComments,
  readDiagramCommentsFile,
  resolveDiagramComment,
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

function writeDoc(
  name = "order-flow",
  nodes = [
    { id: "s1-p1", label: "注文を受け付ける" },
    { id: "s1-p2", label: "在庫を確認する" },
  ]
) {
  const anchors = nodes
    .map(node => `<p data-ark-id="${node.id}">${node.label}</p>`)
    .join("");
  fs.writeFileSync(
    path.join(worktree, `.claude/diagrams/${name}.diagram.html`),
    `<!doctype html><html><body><script type="application/json" id="ark-diagram-model">${JSON.stringify({ version: 1, type: "doc", nodes, edges: [], groups: [] })}</script>${anchors}</body></html>`
  );
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
  it("author 付きの既存 sidecar を返す", () => {
    expect(parseDiagramComments(JSON.stringify(comments()), target)).toEqual({
      ok: true,
      comments: comments(),
    });
  });

  it("author 無しの sidecar を返す", () => {
    const authorless = structuredClone(comments());
    const message = authorless.threads[0]?.messages[0];
    if (!message) throw new Error("comment message expected");
    delete (message as { author?: string }).author;

    expect(parseDiagramComments(JSON.stringify(authorless), target)).toEqual({
      ok: true,
      comments: authorless,
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
          anchorQuote: "q".repeat(DIAGRAM_COMMENTS_MAX_ANCHOR_QUOTE_LENGTH),
          anchorOccurrence: 0,
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

  it("anchorQuote 無しの従来 thread と quote 単独を受け付ける", () => {
    const legacy = parseDiagramComments(JSON.stringify(comments()), target);
    const quotedThread = {
      ...comments().threads[0],
      anchorQuote: "注文を受け付ける",
    };
    const quoted = parseDiagramComments(
      JSON.stringify(comments({ threads: [quotedThread] })),
      target
    );

    expect(legacy.ok).toBe(true);
    expect(quoted).toMatchObject({
      ok: true,
      comments: { threads: [{ anchorQuote: "注文を受け付ける" }] },
    });
  });

  it.each([
    ["空", ""],
    ["空白のみ", "   "],
    ["上限超過", "q".repeat(DIAGRAM_COMMENTS_MAX_ANCHOR_QUOTE_LENGTH + 1)],
  ])("anchorQuote が%sなら拒否する", (_name, anchorQuote) => {
    const thread = { ...comments().threads[0], anchorQuote };

    expect(
      parseDiagramComments(
        JSON.stringify(comments({ threads: [thread] })),
        target
      ).ok
    ).toBe(false);
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    "anchorOccurrence=%s を拒否する",
    anchorOccurrence => {
      const thread = {
        ...comments().threads[0],
        anchorQuote: "注文",
        anchorOccurrence,
      };

      expect(
        parseDiagramComments(
          JSON.stringify(comments({ threads: [thread] })),
          target
        ).ok
      ).toBe(false);
    }
  );

  it("anchorOccurrence 単独を拒否し、quote と非負整数の組を受け付ける", () => {
    const occurrenceOnly = {
      ...comments().threads[0],
      anchorOccurrence: 0,
    };
    const pair = {
      ...comments().threads[0],
      anchorQuote: "注文",
      anchorOccurrence: 2,
    };

    expect(
      parseDiagramComments(
        JSON.stringify(comments({ threads: [occurrenceOnly] })),
        target
      ).ok
    ).toBe(false);
    expect(
      parseDiagramComments(
        JSON.stringify(comments({ threads: [pair] })),
        target
      )
    ).toMatchObject({
      ok: true,
      comments: {
        threads: [{ anchorQuote: "注文", anchorOccurrence: 2 }],
      },
    });
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

describe("comment mutations", () => {
  const relPath = ".claude/diagrams/order-flow.diagram.html";

  it("create は author を書かず server ID/時刻と最新 node label で open thread を追加する", async () => {
    writeDoc();

    const result = await createDiagramComment(
      worktree,
      relPath,
      "s1-p1",
      "確認してください"
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      const thread = result.comments.threads[0];
      expect(thread).toMatchObject({
        anchorId: "s1-p1",
        anchorText: "注文を受け付ける",
        status: "open",
        messages: [{ body: "確認してください" }],
      });
      expect(thread?.messages[0]).not.toHaveProperty("author");
      expect(thread?.id).toMatch(/^th-[0-9a-f-]{36}$/u);
      expect(thread?.messages[0]?.id).toMatch(/^m-[0-9a-f-]{36}$/u);
      expect(Date.parse(thread?.createdAt ?? "invalid")).not.toBeNaN();
      expect(thread?.messages[0]?.at).toBe(thread?.createdAt);
    }
  });

  it("create は選択 quote と occurrence を保存し、quote を表示抜粋にする", async () => {
    writeDoc();
    const anchorQuote = `  ${"選".repeat(300)}  `;

    const result = await createDiagramComment(
      worktree,
      relPath,
      "s1-p1",
      "確認してください",
      anchorQuote,
      2
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.comments.threads[0]).toMatchObject({
        anchorQuote,
        anchorOccurrence: 2,
        anchorText: "選".repeat(DIAGRAM_COMMENTS_MAX_ANCHOR_OR_ID_LENGTH),
      });
    }
  });

  it.each([
    ["空 label", ""],
    ["空白のみの label", " \t "],
    [
      "上限超の label",
      ` ${"長".repeat(DIAGRAM_COMMENTS_MAX_ANCHOR_OR_ID_LENGTH + 1)} `,
    ],
  ])(
    "create は %s を保存可能な anchorText に正規化する",
    async (_name, label) => {
      writeDoc("order-flow", [{ id: "s1-p1", label }]);

      const result = await createDiagramComment(
        worktree,
        relPath,
        "s1-p1",
        "確認してください"
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const anchorText = result.comments.threads[0]?.anchorText ?? "";
        expect(anchorText.trim().length).toBeGreaterThan(0);
        expect(anchorText.length).toBeLessThanOrEqual(
          DIAGRAM_COMMENTS_MAX_ANCHOR_OR_ID_LENGTH
        );
      }
    }
  );

  it("client が指定できない値を受け取らず、未知 anchor を拒否する", async () => {
    writeDoc();

    const result = await createDiagramComment(
      worktree,
      relPath,
      "unknown",
      "本文"
    );

    expect(result).toMatchObject({ ok: false, code: "ANCHOR_NOT_FOUND" });
    expect(
      fs.existsSync(
        path.join(worktree, ".claude/diagrams/order-flow.comments.json")
      )
    ).toBe(false);
  });

  it("doc 以外を NOT_DOC にする", async () => {
    const graphModel = {
      version: 1,
      nodes: [{ id: "s1-p1", label: "Graph" }],
      edges: [],
      groups: [],
    };
    fs.writeFileSync(
      path.join(worktree, ".claude/diagrams/order-flow.diagram.html"),
      `<script type="application/json" id="ark-diagram-model">${JSON.stringify(graphModel)}</script><div data-model-id="s1-p1"></div>`
    );

    await expect(
      createDiagramComment(worktree, relPath, "s1-p1", "本文")
    ).resolves.toMatchObject({ ok: false, code: "NOT_DOC" });
  });

  it("resolve は open thread だけを resolved にし、再実行は冪等", async () => {
    writeDoc();
    const created = await createDiagramComment(
      worktree,
      relPath,
      "s1-p1",
      "本文"
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const threadId = created.comments.threads[0]?.id ?? "";

    const resolved = await resolveDiagramComment(worktree, relPath, threadId);
    const again = await resolveDiagramComment(worktree, relPath, threadId);

    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.comments.threads[0]?.status).toBe("resolved");
      expect(resolved.comments.threads[0]?.messages).toEqual(
        created.comments.threads[0]?.messages
      );
    }
    expect(again).toEqual(resolved);
  });

  it("未知 thread を THREAD_NOT_FOUND にする", async () => {
    writeDoc();

    await expect(
      resolveDiagramComment(worktree, relPath, "th-unknown")
    ).resolves.toMatchObject({ ok: false, code: "THREAD_NOT_FOUND" });
  });

  it("delete は指定 thread だけを削除して最新 comments を返す", async () => {
    writeDoc();
    const [first, second] = await Promise.all([
      createDiagramComment(worktree, relPath, "s1-p1", "first"),
      createDiagramComment(worktree, relPath, "s1-p2", "second"),
    ]);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    const firstId = first.comments.threads[0]?.id;
    if (!firstId) throw new Error("first thread expected");

    const deleted = await deleteDiagramComment(worktree, relPath, firstId);

    expect(deleted).toMatchObject({
      ok: true,
      comments: { threads: [{ anchorId: "s1-p2" }] },
    });
  });

  it("delete は未知 thread を THREAD_NOT_FOUND にする", async () => {
    writeDoc();

    await expect(
      deleteDiagramComment(worktree, relPath, "th-unknown")
    ).resolves.toMatchObject({ ok: false, code: "THREAD_NOT_FOUND" });
  });

  it("delete は最後の thread を消すと sidecar 自体を削除する", async () => {
    writeDoc();
    const created = await createDiagramComment(
      worktree,
      relPath,
      "s1-p1",
      "本文"
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const threadId = created.comments.threads[0]?.id;
    if (!threadId) throw new Error("thread expected");
    const sidecar = path.join(
      worktree,
      ".claude/diagrams/order-flow.comments.json"
    );

    const deleted = await deleteDiagramComment(worktree, relPath, threadId);

    expect(deleted).toEqual({
      ok: true,
      comments: { version: 1, target, threads: [] },
    });
    expect(fs.existsSync(sidecar)).toBe(false);
  });

  it("delete は Windows では sidecar が存在しても FORBIDDEN にして削除しない", async () => {
    writeDoc();
    const created = await createDiagramComment(
      worktree,
      relPath,
      "s1-p1",
      "本文"
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const threadId = created.comments.threads[0]?.id;
    if (!threadId) throw new Error("thread expected");
    const sidecar = path.join(
      worktree,
      ".claude/diagrams/order-flow.comments.json"
    );
    const original = fs.readFileSync(sidecar, "utf8");

    const deleted = await deleteDiagramComment(worktree, relPath, threadId, {
      platform: "win32",
    });

    expect(deleted).toEqual({
      ok: false,
      code: "FORBIDDEN",
      error:
        "この環境では symlink を安全に検証できないためコメントを削除できません",
    });
    expect(fs.readFileSync(sidecar, "utf8")).toBe(original);
  });

  it("delete は Linux では最後の thread と sidecar を削除する", async () => {
    writeDoc();
    const created = await createDiagramComment(
      worktree,
      relPath,
      "s1-p1",
      "本文"
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const threadId = created.comments.threads[0]?.id;
    if (!threadId) throw new Error("thread expected");
    const sidecar = path.join(
      worktree,
      ".claude/diagrams/order-flow.comments.json"
    );

    const deleted = await deleteDiagramComment(worktree, relPath, threadId, {
      platform: "linux",
    });

    expect(deleted).toEqual({
      ok: true,
      comments: { version: 1, target, threads: [] },
    });
    expect(fs.existsSync(sidecar)).toBe(false);
  });

  it("最後の thread 削除後に unlink が失敗しても空 sidecar を残して成功する", async () => {
    writeDoc();
    const created = await createDiagramComment(
      worktree,
      relPath,
      "s1-p1",
      "本文"
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const threadId = created.comments.threads[0]?.id;
    if (!threadId) throw new Error("thread expected");
    const sidecar = path.join(
      worktree,
      ".claude/diagrams/order-flow.comments.json"
    );
    const unlink = fs.promises.unlink.bind(fs.promises);
    vi.spyOn(fs.promises, "unlink").mockImplementation(async targetPath => {
      if (targetPath === sidecar) {
        throw Object.assign(new Error("unlink denied"), { code: "EACCES" });
      }
      return unlink(targetPath);
    });

    const deleted = await deleteDiagramComment(worktree, relPath, threadId);

    expect(deleted).toEqual({
      ok: true,
      comments: { version: 1, target, threads: [] },
    });
    expect(fs.existsSync(sidecar)).toBe(true);
    await expect(readDiagramCommentsFile(worktree, relPath)).resolves.toEqual(
      deleted
    );
  });

  it("同じ sidecar への並行 delete を直列化して両方削除する", async () => {
    writeDoc();
    await Promise.all([
      createDiagramComment(worktree, relPath, "s1-p1", "first"),
      createDiagramComment(worktree, relPath, "s1-p2", "second"),
    ]);
    const stored = await readDiagramCommentsFile(worktree, relPath);
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    const threadIds = stored.comments.threads.map(thread => thread.id);

    const deleted = await Promise.all(
      threadIds.map(threadId =>
        deleteDiagramComment(worktree, relPath, threadId)
      )
    );

    expect(deleted.every(result => result.ok)).toBe(true);
    await expect(readDiagramCommentsFile(worktree, relPath)).resolves.toEqual({
      ok: true,
      comments: { version: 1, target, threads: [] },
    });
  });

  it("同じ sidecar への並行 create を直列化して両方保持する", async () => {
    writeDoc();

    await Promise.all([
      createDiagramComment(worktree, relPath, "s1-p1", "first"),
      createDiagramComment(worktree, relPath, "s1-p2", "second"),
    ]);

    const stored = await readDiagramCommentsFile(worktree, relPath);
    expect(stored.ok).toBe(true);
    if (stored.ok) {
      expect(stored.comments.threads).toHaveLength(2);
      expect(
        stored.comments.threads.map(thread => thread.anchorId).sort()
      ).toEqual(["s1-p1", "s1-p2"]);
    }
  });

  it("別 sidecar の mutation は独立して成功する", async () => {
    writeDoc("order-flow");
    writeDoc("shipping-flow");

    const results = await Promise.all([
      createDiagramComment(worktree, relPath, "s1-p1", "first"),
      createDiagramComment(
        worktree,
        ".claude/diagrams/shipping-flow.diagram.html",
        "s1-p2",
        "second"
      ),
    ]);

    expect(results.every(result => result.ok)).toBe(true);
    expect(
      fs.existsSync(
        path.join(worktree, ".claude/diagrams/order-flow.comments.json")
      )
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(worktree, ".claude/diagrams/shipping-flow.comments.json")
      )
    ).toBe(true);
  });

  it("target が symlink なら拒否し、外部 file を変更しない", async () => {
    writeDoc();
    const outside = path.join(worktree, "outside.json");
    fs.writeFileSync(outside, "outside");
    fs.symlinkSync(
      outside,
      path.join(worktree, ".claude/diagrams/order-flow.comments.json")
    );

    const result = await createDiagramComment(
      worktree,
      relPath,
      "s1-p1",
      "本文"
    );

    expect(result).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(fs.readFileSync(outside, "utf8")).toBe("outside");
  });

  it("atomic write 失敗時は元 sidecar を保持し temp を消す", async () => {
    writeDoc();
    const first = await createDiagramComment(
      worktree,
      relPath,
      "s1-p1",
      "first"
    );
    expect(first.ok).toBe(true);
    const sidecar = path.join(
      worktree,
      ".claude/diagrams/order-flow.comments.json"
    );
    const original = fs.readFileSync(sidecar, "utf8");
    vi.spyOn(fs.promises, "rename").mockRejectedValueOnce(
      Object.assign(new Error("rename failed"), { code: "EIO" })
    );

    const result = await createDiagramComment(
      worktree,
      relPath,
      "s1-p2",
      "second"
    );

    expect(result).toMatchObject({ ok: false, code: "IO_ERROR" });
    expect(fs.readFileSync(sidecar, "utf8")).toBe(original);
    expect(
      fs
        .readdirSync(path.dirname(sidecar))
        .filter(name => name.includes(".tmp"))
    ).toEqual([]);
  });
});
