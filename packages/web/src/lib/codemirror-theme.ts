import {
  defaultHighlightStyle,
  HighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/**
 * codemirror-theme - エディタ (CodeEditor) と差分 (GitDiffView) が共有する見た目。
 * どちらも同じ配色・同じフォントで出す
 */

/** index.css の --font-mono と同じ並び (@theme inline の変数は実行時に参照できない) */
export const FONT_MONO =
  'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace';

/**
 * アプリは prefers-color-scheme で同じ名前の変数を明暗に切り替える。
 * 色を変数で指しておけば、エディタも OS の設定に追従する
 */
export const arkTheme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "13px",
    color: "var(--foreground)",
    backgroundColor: "var(--background)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: FONT_MONO, lineHeight: "1.5" },
  ".cm-content": { caretColor: "var(--foreground)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--foreground)" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--muted-foreground)",
    border: "none",
  },
  ".cm-activeLine": {
    backgroundColor: "color-mix(in oklch, var(--muted) 55%, transparent)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "var(--muted)",
    color: "var(--foreground)",
  },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    {
      backgroundColor: "color-mix(in oklch, var(--primary) 26%, transparent)",
    },
  ".cm-selectionMatch": {
    backgroundColor: "color-mix(in oklch, var(--primary) 14%, transparent)",
  },
  ".cm-foldPlaceholder": {
    backgroundColor: "var(--muted)",
    border: "1px solid var(--border)",
    color: "var(--muted-foreground)",
  },
  ".cm-panels": {
    backgroundColor: "var(--muted)",
    color: "var(--foreground)",
  },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--border)" },
  ".cm-textfield": {
    backgroundColor: "var(--background)",
    color: "var(--foreground)",
    border: "1px solid var(--border)",
  },
  ".cm-button": {
    backgroundImage: "none",
    backgroundColor: "var(--background)",
    color: "var(--foreground)",
    border: "1px solid var(--border)",
  },
  ".cm-tooltip": {
    backgroundColor: "var(--popover)",
    color: "var(--popover-foreground)",
    border: "1px solid var(--border)",
  },
  // FileViewerPane (shiki) の行ハイライトと同じ色
  ".cm-ark-target-line": { backgroundColor: "rgba(56, 139, 253, 0.28)" },
});

/**
 * 既定のハイライト (明るい背景向け) の色に、暗い背景での対を付ける。
 * light-dark() は :root の color-scheme に従うので、テーマと同じく OS に追従する。
 * タグの割り当ては既定のものをそのまま使い、色だけを差し替える
 */
const DARK_COLORS: Record<string, string> = {
  "#404740": "#9aa5a0",
  "#708": "#c792ea",
  "#219": "#79c0ff",
  "#164": "#7ee787",
  "#a11": "#f29a8e",
  "#e40": "#ffa657",
  "#00f": "#79b8ff",
  "#30a": "#b3a1ff",
  "#085": "#56d4bc",
  "#167": "#6cc6d9",
  "#256": "#8fb3d9",
  "#00c": "#8ab4ff",
  "#940": "#c9a26b",
  "#f00": "#ff6b6b",
};

export const arkHighlightStyle = HighlightStyle.define(
  defaultHighlightStyle.specs.map(spec => {
    const color = typeof spec.color === "string" ? spec.color : null;
    const dark = color ? DARK_COLORS[color] : undefined;
    return dark ? { ...spec, color: `light-dark(${color}, ${dark})` } : spec;
  })
);

/** テーマと構文ハイライトの組。エディタと差分の両方がこれを入れる */
export const arkEditorLook: Extension = [
  arkTheme,
  syntaxHighlighting(arkHighlightStyle),
];
