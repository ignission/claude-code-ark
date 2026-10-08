import {
  defaultHighlightStyle,
  HighlightStyle,
  LanguageDescription,
  syntaxHighlighting,
} from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import {
  Compartment,
  EditorState,
  type Extension,
  type Range,
  StateEffect,
  StateField,
  type Text,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
} from "@codemirror/view";
import { basicSetup } from "codemirror";
import { useEffect, useRef } from "react";

interface CodeEditorProps {
  /** 言語の判定に使う */
  filePath: string;
  /** 読み込んだ内容。loadSeq が変わったときだけ文書を差し替える */
  value: string;
  loadSeq: number;
  readOnly: boolean;
  targetLine?: number | null;
  targetEndLine?: number | null;
  /** 変わったら targetLine へスクロール */
  revealSeq: number;
  onChange: (value: string) => void;
  /** Mod-s */
  onSave: () => void;
}

/** index.css の --font-mono と同じ並び (@theme inline の変数は実行時に参照できない) */
const FONT_MONO =
  'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace';

/**
 * アプリは prefers-color-scheme で同じ名前の変数を明暗に切り替える。
 * 色を変数で指しておけば、エディタも OS の設定に追従する
 */
const arkTheme = EditorView.theme({
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
    backgroundColor: "var(--background)",
    color: "var(--muted-foreground)",
    borderRight: "1px solid var(--border)",
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

const arkHighlightStyle = HighlightStyle.define(
  defaultHighlightStyle.specs.map(spec => {
    const color = typeof spec.color === "string" ? spec.color : null;
    const dark = color ? DARK_COLORS[color] : undefined;
    return dark ? { ...spec, color: `light-dark(${color}, ${dark})` } : spec;
  })
);

interface LineRange {
  from: number;
  to: number;
}

/** 行指定を 1 始まりの範囲にする。逆順は入れ替える。指定が無ければ null */
function toLineRange(
  start?: number | null,
  end?: number | null
): LineRange | null {
  if (!start || start < 1) return null;
  if (!end || end < 1) return { from: start, to: start };
  return { from: Math.min(start, end), to: Math.max(start, end) };
}

const setTargetLines = StateEffect.define<LineRange | null>();
const targetLineMark = Decoration.line({ class: "cm-ark-target-line" });

function buildTargetLines(doc: Text, range: LineRange | null): DecorationSet {
  if (!range || range.from > doc.lines) return Decoration.none;
  const marks: Range<Decoration>[] = [];
  const last = Math.min(range.to, doc.lines);
  for (let n = range.from; n <= last; n++) {
    marks.push(targetLineMark.range(doc.line(n).from));
  }
  return Decoration.set(marks);
}

const targetLinesField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let next = value.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setTargetLines)) {
        next = buildTargetLines(tr.state.doc, effect.value);
      }
    }
    return next;
  },
  provide: field => EditorView.decorations.from(field),
});

/** 範囲の先頭行を中央へ寄せる effect。行が文書の外なら何もしない */
function revealEffect(doc: Text, range: LineRange | null) {
  if (!range || range.from > doc.lines) return null;
  return EditorView.scrollIntoView(doc.line(range.from).from, { y: "center" });
}

/**
 * CodeMirror 6 の薄い包み。EditorView は 1 度だけ作り、以後は transaction と
 * Compartment で追従する (作り直すとスクロール位置と選択が消える)。
 * 読み直しのときだけ state を作り直し、undo 履歴を捨てる
 */
export default function CodeEditor({
  filePath,
  value,
  loadSeq,
  readOnly,
  targetLine,
  targetEndLine,
  revealSeq,
  onChange,
  onSave,
}: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const readOnlyComp = useRef(new Compartment());
  const languageComp = useRef(new Compartment());

  // view を作り直さずに最新の props を読むための ref
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const rangeRef = useRef<LineRange | null>(null);
  rangeRef.current = toLineRange(targetLine, targetEndLine);
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  /** 読み込み済みの言語定義。state を作り直すときに引き継ぐ */
  const languageRef = useRef<Extension>([]);
  const initialValue = useRef(value);

  /** 今の props と読み込み済みの言語で state を組む。Compartment は使い回す */
  const createState = useRef(
    (doc: string, selection?: { anchor: number; head: number }) =>
      EditorState.create({
        doc,
        selection,
        extensions: [
          // basicSetup より前に置き、Mod-s を必ずここで受ける
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                onSaveRef.current();
                return true;
              },
            },
          ]),
          // Tab はインデントに割り当てない (basicSetup も入れていない)。
          // 割り当てると、キーボードでエディタの外へ出られなくなる
          basicSetup,
          arkTheme,
          syntaxHighlighting(arkHighlightStyle),
          targetLinesField.init(s => buildTargetLines(s.doc, rangeRef.current)),
          readOnlyComp.current.of(EditorState.readOnly.of(readOnlyRef.current)),
          languageComp.current.of(languageRef.current),
          EditorView.updateListener.of(update => {
            if (update.docChanged) {
              onChangeRef.current(update.state.doc.toString());
            }
          }),
        ],
      })
  ).current;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const state = createState(initialValue.current);
    const view = new EditorView({
      state,
      parent: host,
      scrollTo: revealEffect(state.doc, rangeRef.current) ?? undefined,
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [createState]);

  // 読み直し: state ごと作り直す。transaction で文書を差し替えると undo 履歴が
  // 残り、古い編集の取り消しが新しい内容へ継ぎ足される。setState は transaction を
  // 流さないので onChange は呼ばれない。スクロール位置と選択は引き継ぐ
  const appliedLoadSeq = useRef(loadSeq);
  useEffect(() => {
    const view = viewRef.current;
    if (!view || appliedLoadSeq.current === loadSeq) return;
    appliedLoadSeq.current = loadSeq;
    const { anchor, head } = view.state.selection.main;
    const scrollTop = view.scrollDOM.scrollTop;
    const scrollLeft = view.scrollDOM.scrollLeft;
    const restoreScroll = () => {
      view.scrollDOM.scrollTop = scrollTop;
      view.scrollDOM.scrollLeft = scrollLeft;
    };
    // CodeMirror は CR と CRLF を 1 文字の改行にするので、揃えたあとの長さで収める
    const length = value.replace(/\r\n?/g, "\n").length;
    view.setState(
      createState(value, {
        anchor: Math.min(anchor, length),
        head: Math.min(head, length),
      })
    );
    restoreScroll();
    // 行の高さを測り直したあとにも戻す (測る前は見積もりの高さで切り詰められうる)
    view.requestMeasure({ read: () => null, write: restoreScroll });
  }, [loadSeq, value, createState]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: readOnlyComp.current.reconfigure(
        EditorState.readOnly.of(readOnly)
      ),
    });
  }, [readOnly]);

  // 言語定義は必要になったものだけ遅延ロードする
  useEffect(() => {
    let cancelled = false;
    const name = filePath.split("/").pop() ?? filePath;
    const description = LanguageDescription.matchFilename(languages, name);
    const apply = (extension: Extension) => {
      if (cancelled) return;
      languageRef.current = extension;
      viewRef.current?.dispatch({
        effects: languageComp.current.reconfigure(extension),
      });
    };
    if (!description) {
      apply([]);
    } else {
      description.load().then(apply, () => apply([]));
    }
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  // 行指定: ハイライトを張り直し、revealSeq が変わったら先頭行へ寄せる。
  // 初回は view の生成時に済ませている
  const appliedReveal = useRef({ targetLine, targetEndLine, revealSeq });
  useEffect(() => {
    const view = viewRef.current;
    const prev = appliedReveal.current;
    if (
      !view ||
      (prev.targetLine === targetLine &&
        prev.targetEndLine === targetEndLine &&
        prev.revealSeq === revealSeq)
    ) {
      return;
    }
    appliedReveal.current = { targetLine, targetEndLine, revealSeq };
    const range = toLineRange(targetLine, targetEndLine);
    const reveal =
      prev.revealSeq !== revealSeq ? revealEffect(view.state.doc, range) : null;
    view.dispatch({
      effects: reveal
        ? [setTargetLines.of(range), reveal]
        : setTargetLines.of(range),
    });
  }, [targetLine, targetEndLine, revealSeq]);

  return <div ref={hostRef} className="h-full min-h-0 overflow-hidden" />;
}
