#!/usr/bin/env node
/**
 * npm に公開するパッケージ (`claude-code-ark`) を `release/npm/` に組み立てる。
 * `pnpm build` のあとに実行する。
 *
 * ワークスペースのパッケージをそのまま公開しない理由:
 *   - `@ark/server` は `@ark/shared` を `workspace:*` で参照していて、npm では解決できない
 *     (中身は esbuild がサーバーの成果物へ束ね済みなので、公開物の依存には要らない)
 *   - Web の成果物は別パッケージ (`packages/web/dist`) にあり、1つにまとめる必要がある
 *
 * 依存の版は、いま手元に入っている版へ固定する。npx は lockfile を見ないので、
 * 範囲のまま公開すると、利用者ごとに検証していない版 (特に同梱の claude) で動く。
 */

import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverDir = path.join(rootDir, "packages/server");
const outDir = path.join(rootDir, "release/npm");

const readJson = async file => JSON.parse(await readFile(file, "utf-8"));

const rootPkg = await readJson(path.join(rootDir, "package.json"));
const serverPkg = await readJson(path.join(serverDir, "package.json"));

const dependencies = {};
for (const name of Object.keys(serverPkg.dependencies).sort()) {
  if (name.startsWith("@ark/")) continue;
  // require.resolve は使わない。exports が package.json を別のファイルへ向けるパッケージがある
  const installed = await readJson(
    path.join(serverDir, "node_modules", name, "package.json")
  );
  if (!installed.version) {
    throw new Error(`[pack-npm] ${name} の版を読めません`);
  }
  dependencies[name] = installed.version;
}

await rm(outDir, { recursive: true, force: true });
await mkdir(path.join(outDir, "dist"), { recursive: true });

// サーバーは cli-main.js の1ファイルに束ねてある。bin.js はそれを実行時に読む入口
for (const file of ["bin.js", "cli-main.js", "diagram-authoring-guide.md"]) {
  await cp(path.join(serverDir, "dist", file), path.join(outDir, "dist", file));
}
await cp(path.join(rootDir, "packages/web/dist"), path.join(outDir, "web"), {
  recursive: true,
});
for (const file of ["README.md", "README.ja.md", "LICENSE", "NOTICE"]) {
  await cp(path.join(rootDir, file), path.join(outDir, file));
}

await writeFile(
  path.join(outDir, "package.json"),
  `${JSON.stringify(
    {
      name: rootPkg.name,
      version: rootPkg.version,
      description:
        "Web UI for running multiple Claude Code sessions from your desktop and phone",
      license: rootPkg.license,
      repository: {
        type: "git",
        url: "git+https://github.com/ignission/claude-code-ark.git",
      },
      type: "module",
      bin: { "claude-code-ark": "dist/bin.js" },
      files: ["dist", "web", "NOTICE", "README.ja.md"],
      engines: rootPkg.engines,
      os: ["linux", "darwin"],
      dependencies,
    },
    null,
    2
  )}\n`
);

console.log(`[pack-npm] ${rootPkg.name}@${rootPkg.version} → ${outDir}`);
