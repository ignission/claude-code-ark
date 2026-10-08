/**
 * ファイルツリー・タブ用のアイコン対応表 (material-icon-theme の一部だけを使う)。
 * 同梱する SVG は file-icon-assets.ts の glob と対応表の値が一致するものに限る。
 */

/** 拡張子 (複合拡張子を含む。先頭のドットなし・小文字) → アイコン名 */
const BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  "d.ts": "typescript-def",
  "d.mts": "typescript-def",
  "d.cts": "typescript-def",
  tsx: "react_ts",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "react",
  "test.ts": "test-ts",
  "spec.ts": "test-ts",
  "test.tsx": "test-jsx",
  "spec.tsx": "test-jsx",
  "test.js": "test-js",
  "spec.js": "test-js",
  "test.jsx": "test-jsx",
  "spec.jsx": "test-jsx",
  json: "json",
  jsonc: "json",
  json5: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  md: "markdown",
  markdown: "markdown",
  mdx: "mdx",
  html: "html",
  htm: "html",
  css: "css",
  scss: "sass",
  sass: "sass",
  svg: "svg",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  ico: "image",
  avif: "image",
  bmp: "image",
  pdf: "pdf",
  sh: "console",
  bash: "console",
  zsh: "console",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "h",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "hpp",
  cs: "csharp",
  php: "php",
  lua: "lua",
  dart: "dart",
  sql: "database",
  graphql: "graphql",
  gql: "graphql",
  proto: "proto",
  vue: "vue",
  svelte: "svelte",
  xml: "xml",
  txt: "document",
  log: "log",
  csv: "table",
  lock: "lock",
  env: "tune",
  zip: "zip",
  tar: "zip",
  gz: "zip",
  tgz: "zip",
  "7z": "zip",
  woff: "font",
  woff2: "font",
  ttf: "font",
  otf: "font",
  mp4: "video",
  mov: "video",
  webm: "video",
  mp3: "audio",
  wav: "audio",
  ogg: "audio",
};

/** ファイル名 (小文字) 全体の一致 */
const BY_FILE_NAME: Record<string, string> = {
  "package.json": "nodejs",
  "pnpm-lock.yaml": "pnpm",
  "pnpm-workspace.yaml": "pnpm",
  "yarn.lock": "yarn",
  "package-lock.json": "npm",
  "biome.json": "biome",
  "biome.jsonc": "biome",
  ".gitignore": "git",
  ".gitattributes": "git",
  ".gitkeep": "git",
  ".gitmodules": "git",
  dockerfile: "docker",
  ".dockerignore": "docker",
  "docker-compose.yml": "docker",
  "docker-compose.yaml": "docker",
  makefile: "makefile",
  "readme.md": "readme",
  license: "license",
  "license.md": "license",
  "license.txt": "license",
  "claude.md": "claude",
  ".editorconfig": "editorconfig",
  "renovate.json": "renovate",
  "renovate.json5": "renovate",
  ".renovaterc": "renovate",
  ".renovaterc.json": "renovate",
  ".mise.toml": "settings",
  "mise.toml": "settings",
};

/** ファイル名 (小文字) の形による一致。拡張子より優先する */
const BY_FILE_PATTERN: [RegExp, string][] = [
  [/^tsconfig(\..+)?\.json$/, "tsconfig"],
  [/^vite\.config\./, "vite"],
  [/^vitest\.config\./, "vitest"],
  [/^playwright\.config\./, "playwright"],
  [/^\.env(\..+)?$/, "tune"],
  [/^(\.eslintrc|eslint\.config\.)/, "eslint"],
  [/^(\.prettierrc|prettier\.config\.)/, "prettier"],
];

/** ディレクトリ名 (小文字) → フォルダ名 (開閉の接尾辞を除く) */
const BY_FOLDER_NAME: Record<string, string> = {
  src: "folder-src",
  lib: "folder-lib",
  dist: "folder-dist",
  build: "folder-dist",
  out: "folder-dist",
  node_modules: "folder-node",
  test: "folder-test",
  tests: "folder-test",
  __tests__: "folder-test",
  e2e: "folder-test",
  docs: "folder-docs",
  doc: "folder-docs",
  public: "folder-public",
  assets: "folder-resource",
  components: "folder-components",
  hooks: "folder-hook",
  pages: "folder-routes",
  routes: "folder-routes",
  scripts: "folder-scripts",
  packages: "folder-packages",
  config: "folder-config",
  types: "folder-typescript",
  utils: "folder-utils",
  ".github": "folder-github",
  ".git": "folder-git",
  ".vscode": "folder-vscode",
  ".claude": "folder-claude",
  server: "folder-server",
  client: "folder-client",
  web: "folder-client",
  shared: "folder-shared",
  data: "folder-database",
  images: "folder-images",
  styles: "folder-css",
};

const DEFAULT_FOLDER = "folder";
const OPEN_SUFFIX = "-open";

/** ファイル名に対応するアイコン名。対応がなければ null (呼び出し側が汎用アイコンを出す) */
export function fileIconName(fileName: string): string | null {
  const lower = fileName.toLowerCase();
  const exact = BY_FILE_NAME[lower];
  if (exact) return exact;
  for (const [pattern, icon] of BY_FILE_PATTERN) {
    if (pattern.test(lower)) return icon;
  }
  // 先頭のドットは拡張子の区切りとして数えない。最も長い複合拡張子から順に試す
  for (let i = lower.indexOf(".", 1); i !== -1; i = lower.indexOf(".", i + 1)) {
    const icon = BY_EXTENSION[lower.slice(i + 1)];
    if (icon) return icon;
  }
  return null;
}

/** ディレクトリ名に対応するフォルダのアイコン名 (未対応は汎用フォルダ) */
export function folderIconName(dirName: string, open: boolean): string {
  const base = BY_FOLDER_NAME[dirName.toLowerCase()] ?? DEFAULT_FOLDER;
  return open ? `${base}${OPEN_SUFFIX}` : base;
}

/** 対応表が参照するアイコン名の全集合 (開閉の両方を含む) */
export function allMappedIconNames(): Set<string> {
  const names = new Set<string>([
    ...Object.values(BY_EXTENSION),
    ...Object.values(BY_FILE_NAME),
    ...BY_FILE_PATTERN.map(([, icon]) => icon),
  ]);
  for (const base of [DEFAULT_FOLDER, ...Object.values(BY_FOLDER_NAME)]) {
    names.add(base);
    names.add(`${base}${OPEN_SUFFIX}`);
  }
  return names;
}

// --- SVG 資産の遅延読み込み (メインのバンドルに SVG を入れない) ---

export interface FileIconAssets {
  iconUrl: (name: string) => string | undefined;
}

let assets: FileIconAssets | null = null;
let loading: Promise<FileIconAssets> | null = null;
const listeners = new Set<() => void>();

/** 資産を一度だけ動的 import する。全 FileIcon が同じ読み込みを共有する */
export function loadFileIconAssets(): Promise<FileIconAssets> {
  loading ??= import("./file-icon-assets").then(mod => {
    assets = mod;
    for (const l of listeners) l();
    return mod;
  });
  return loading;
}

export function subscribeFileIconAssets(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getFileIconAssets(): FileIconAssets | null {
  return assets;
}
