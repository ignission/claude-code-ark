import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { bundledIconNames } from "./file-icon-assets";
import { allMappedIconNames, fileIconName, folderIconName } from "./file-icons";

describe("fileIconName", () => {
  it("ファイル名の完全一致を拡張子より優先する", () => {
    expect(fileIconName("package.json")).toBe("nodejs");
    expect(fileIconName("pnpm-lock.yaml")).toBe("pnpm");
    expect(fileIconName("tsconfig.build.json")).toBe("tsconfig");
    expect(fileIconName("vite.config.ts")).toBe("vite");
    expect(fileIconName("CLAUDE.md")).toBe("claude");
    expect(fileIconName("Dockerfile")).toBe("docker");
  });

  it("最も長い複合拡張子を選ぶ", () => {
    expect(fileIconName("a.test.ts")).toBe("test-ts");
    expect(fileIconName("a.spec.tsx")).toBe("test-jsx");
    expect(fileIconName("x.d.ts")).toBe("typescript-def");
    expect(fileIconName("a.b.test.ts")).toBe("test-ts");
    expect(fileIconName("flow.diagram.html")).toBe("html");
  });

  it("最後の拡張子へ落ち、大文字小文字を区別しない", () => {
    expect(fileIconName("a.ts")).toBe("typescript");
    expect(fileIconName("Foo.TSX")).toBe("react_ts");
    expect(fileIconName("README.MD")).toBe("readme");
  });

  it("ドットファイルと未知の拡張子", () => {
    expect(fileIconName(".gitignore")).toBe("git");
    expect(fileIconName(".env.local")).toBe("tune");
    expect(fileIconName(".json")).toBeNull();
    expect(fileIconName("unknown.xyz")).toBeNull();
    expect(fileIconName("noext")).toBeNull();
  });
});

describe("folderIconName", () => {
  it("名前付きフォルダは開閉で名前が変わる", () => {
    expect(folderIconName("src", false)).toBe("folder-src");
    expect(folderIconName("src", true)).toBe("folder-src-open");
    expect(folderIconName("Node_Modules", false)).toBe("folder-node");
  });

  it("未知のフォルダは既定のフォルダ", () => {
    expect(folderIconName("whatever", false)).toBe("folder");
    expect(folderIconName("whatever", true)).toBe("folder-open");
  });
});

describe("アイコン資産", () => {
  it("対応表の名前はすべて SVG が実在する", () => {
    const pkg = createRequire(import.meta.url).resolve(
      "material-icon-theme/package.json"
    );
    const onDisk = new Set(
      readdirSync(path.join(path.dirname(pkg), "icons")).map(f =>
        f.replace(/\.svg$/, "")
      )
    );
    const missing = [...allMappedIconNames()].filter(n => !onDisk.has(n));
    expect(missing).toEqual([]);
  });

  it("file-icon-assets の glob は対応表の名前の集合と一致する", () => {
    expect([...bundledIconNames()].sort()).toEqual(
      [...allMappedIconNames()].sort()
    );
  });
});
