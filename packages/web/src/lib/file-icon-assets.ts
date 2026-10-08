/**
 * 対応表 (file-icons.ts) が参照する SVG だけを束ねる遅延読み込み用モジュール。
 * file-icons.ts から動的 import されるので、メインのバンドルには入らない。
 *
 * glob は静的なリテラルでなければならないため、ブレース内の一覧は手で持つ。
 * 対応表との食い違いは file-icons.test.ts が検出する。
 */
const modules = import.meta.glob<string>(
  "../../node_modules/material-icon-theme/icons/{audio,biome,c,claude,console,cpp,csharp,css,dart,database,docker,document,editorconfig,eslint,folder,folder-claude,folder-claude-open,folder-client,folder-client-open,folder-components,folder-components-open,folder-config,folder-config-open,folder-css,folder-css-open,folder-database,folder-database-open,folder-dist,folder-dist-open,folder-docs,folder-docs-open,folder-git,folder-git-open,folder-github,folder-github-open,folder-hook,folder-hook-open,folder-images,folder-images-open,folder-lib,folder-lib-open,folder-node,folder-node-open,folder-open,folder-packages,folder-packages-open,folder-public,folder-public-open,folder-resource,folder-resource-open,folder-routes,folder-routes-open,folder-scripts,folder-scripts-open,folder-server,folder-server-open,folder-shared,folder-shared-open,folder-src,folder-src-open,folder-test,folder-test-open,folder-typescript,folder-typescript-open,folder-utils,folder-utils-open,folder-vscode,folder-vscode-open,font,git,go,graphql,h,hpp,html,image,java,javascript,json,kotlin,license,lock,log,lua,makefile,markdown,mdx,nodejs,npm,pdf,php,playwright,pnpm,prettier,proto,python,react,react_ts,readme,renovate,ruby,rust,sass,settings,svelte,svg,swift,table,test-js,test-jsx,test-ts,toml,tsconfig,tune,typescript,typescript-def,video,vite,vitest,vue,xml,yaml,yarn,zip}.svg",
  { eager: true, query: "?url", import: "default" }
);

const urls = new Map<string, string>();
for (const [path, url] of Object.entries(modules)) {
  const name = path.slice(path.lastIndexOf("/") + 1, -".svg".length);
  urls.set(name, url);
}

export function iconUrl(name: string): string | undefined {
  return urls.get(name);
}

/** glob が実際に拾ったアイコン名 (テスト用) */
export function bundledIconNames(): string[] {
  return [...urls.keys()];
}
