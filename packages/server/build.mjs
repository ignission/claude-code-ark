import { build } from "esbuild";
import { copyFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.dirname(fileURLToPath(import.meta.url));

// package.json の dependencies を読み込み、@ark/* (ワークスペース内パッケージ) を除外して external とする。
// これにより @ark/shared 等のワークスペース依存はバンドルに inline され、
// dist/ を経由せず本番起動が可能になる。
const pkg = JSON.parse(await readFile("./package.json", "utf-8"));
const externals = Object.keys(pkg.dependencies ?? {}).filter(
  (name) => !name.startsWith("@ark/"),
);

await build({
  entryPoints: [
    "src/index.ts",
    "src/cli.ts",
    "src/lib/*.ts",
    "src/lib/mcp-oauth/*.ts",
  ],
  outdir: "dist",
  bundle: true,
  format: "esm",
  platform: "node",
  external: externals,
  outExtension: { ".js": ".js" },
});

await copyFile(
  path.resolve(
    packageDir,
    "../../.claude/skills/diagram-authoring/SKILL.md",
  ),
  path.resolve(packageDir, "dist/diagram-authoring-guide.md"),
);
