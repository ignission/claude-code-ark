import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { unifiedMergeView } from "@codemirror/merge";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { useEffect, useRef } from "react";
import { arkEditorLook } from "@/lib/codemirror-theme";

interface GitDiffViewProps {
  /** 言語の判定に使う */
  path: string;
  /** 変更前。追加されたファイルは空文字 */
  oldContent: string;
  /** 変更後。削除されたファイルは空文字 */
  newContent: string;
}

/**
 * 差分の地色。@codemirror/merge の既定は下線だけで、行の増減がひと目で分からない。
 * 色は index.css の変数 (明暗それぞれに定義) を指し、エディタと同じく OS の明暗に追従する
 */
const diffTheme = EditorView.theme({
  ".cm-changedLine, .cm-inlineChangedLine": {
    backgroundColor: "var(--git-diff-added-line) !important",
  },
  ".cm-changedText": {
    background: "var(--git-diff-added-text) !important",
  },
  ".cm-insertedLine": {
    backgroundColor: "var(--git-diff-added-line)",
    textDecoration: "none",
  },
  ".cm-deletedChunk": {
    backgroundColor: "var(--git-diff-removed-line) !important",
    paddingLeft: "6px",
  },
  ".cm-deletedChunk .cm-deletedLine, .cm-deletedLine, .cm-deletedLine del": {
    backgroundColor: "transparent",
    textDecoration: "none",
  },
  ".cm-deletedChunk .cm-deletedText, .cm-deletedText": {
    background: "var(--git-diff-removed-text) !important",
  },
  ".cm-changeGutter": { width: "3px", paddingLeft: "1px" },
  ".cm-changedLineGutter, .cm-inlineChangedLineGutter": {
    background: "var(--git-added) !important",
  },
  ".cm-deletedLineGutter": {
    background: "var(--git-removed) !important",
  },
  ".cm-collapsedLines": {
    padding: "3px 10px",
    fontSize: "12px",
    color: "var(--muted-foreground) !important",
    background: "var(--muted) !important",
    borderTop: "1px solid var(--border)",
    borderBottom: "1px solid var(--border)",
  },
});

/**
 * 読み取り専用の差分 (unified)。変更後の内容を本文に置き、変更前を上に差し込む。
 * @codemirror/merge を初期バンドルに入れないよう、GitCommitDetail から React.lazy で読む。
 * 差分は state の作成時に計算されるので、(path, 内容) が変わったら view ごと作り直す
 */
export default function GitDiffView({
  path,
  oldContent,
  newContent,
}: GitDiffViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const languageComp = new Compartment();
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: newContent,
        extensions: [
          basicSetup,
          arkEditorLook,
          diffTheme,
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          languageComp.of([]),
          unifiedMergeView({
            original: oldContent,
            mergeControls: false,
            highlightChanges: true,
            gutter: true,
            collapseUnchanged: { margin: 3, minSize: 6 },
          }),
        ],
      }),
    });

    // 言語定義は必要になったものだけ遅延ロードする
    let cancelled = false;
    const name = path.split("/").pop() ?? path;
    const description = LanguageDescription.matchFilename(languages, name);
    description?.load().then(
      (extension: Extension) => {
        if (cancelled) return;
        view.dispatch({ effects: languageComp.reconfigure(extension) });
      },
      () => {
        // 言語が読めなくても、色なしで差分は読める
      }
    );

    return () => {
      cancelled = true;
      view.destroy();
    };
  }, [path, oldContent, newContent]);

  return (
    <div
      ref={hostRef}
      data-testid="git-diff-view"
      className="h-full min-h-0 overflow-hidden"
    />
  );
}
