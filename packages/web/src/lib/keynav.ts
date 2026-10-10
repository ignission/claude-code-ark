/**
 * keynav - Ark を vim 風のキーで動かすための、キーの解釈 (DOM に触らない部分)
 *
 * Ark の画面は、ほとんどの時間、キーを文字として受け取る場所 (端末・会話の入力欄) に
 * フォーカスがある。そこで「入力モード」と「ノーマルモード」を分け、前置キー
 * (Ctrl+;) でノーマルモードに入ったあとだけ、1 文字のキーを Ark への指示として扱う。
 *
 * vim の Esc を入口にしないのは、会話の入力欄の Esc を Claude 本体と同じ動き
 * (中断など) に割り当て済みで、端末でも Esc は Claude に届ける必要があるため。
 */

/** フォーカスを置く場所。左から順に並ぶ */
export const KEYNAV_REGIONS = ["sidebar", "left", "work"] as const;
export type KeyNavRegion = (typeof KEYNAV_REGIONS)[number];

export type KeyNavWorkTab = "board" | "files" | "git";

export type KeyNavCommand =
  /** 入力モードへ (端末 / 会話の入力欄にフォーカス) */
  | { type: "insert" }
  /** 場所を左右に移る */
  | { type: "region"; dir: -1 | 1 }
  /** いまの場所の中を上下に動く */
  | { type: "move"; dir: -1 | 1 }
  /** 半ページ送る */
  | { type: "page"; dir: -1 | 1 }
  /** 先頭 / 末尾へ */
  | { type: "edge"; to: "start" | "end" }
  /** 次 / 前のセッションへ */
  | { type: "session"; dir: -1 | 1 }
  /** 次の「あなたの番」のセッションへ */
  | { type: "next-your-turn" }
  /** 端末 ↔ 会話 */
  | { type: "toggle-left-mode" }
  /** 作業エリアを開閉 */
  | { type: "toggle-work-area" }
  /** 作業エリアのタブへ */
  | { type: "work-tab"; tab: KeyNavWorkTab }
  /** 次 / 前のファイルタブへ */
  | { type: "file-tab"; dir: -1 | 1 }
  /** ピークを閉じる。無ければ作業エリアを閉じる */
  | { type: "close" }
  /** キーの一覧を出す / 隠す */
  | { type: "help" }
  /** 名前で探して実行するパレットを開く */
  | { type: "palette" }
  /** 打ちかけのキーや一覧を取り消す */
  | { type: "cancel" };

export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

/** 前置キー (Ctrl+;)。日本語入力の切り替えやブラウザの操作と重ならないものを選んだ */
export function isLeaderKey(event: KeyLike): boolean {
  return (
    event.ctrlKey === true &&
    !event.metaKey &&
    !event.altKey &&
    (event.key === ";" || event.code === "Semicolon")
  );
}

export interface KeyNavResolution {
  /** 実行する指示。打ちかけ (`g` の 1 打目) や効かないキーでは無い */
  command?: KeyNavCommand;
  /** 次のキーを待っている打ちかけ ("" か "g") */
  pending: string;
  /** Ark がこのキーを受け取ったか。false ならブラウザの既定の動きに任せる */
  handled: boolean;
}

const SINGLE_KEYS: Readonly<Record<string, KeyNavCommand>> = {
  i: { type: "insert" },
  a: { type: "insert" },
  h: { type: "region", dir: -1 },
  l: { type: "region", dir: 1 },
  j: { type: "move", dir: 1 },
  k: { type: "move", dir: -1 },
  G: { type: "edge", to: "end" },
  J: { type: "session", dir: 1 },
  K: { type: "session", dir: -1 },
  n: { type: "next-your-turn" },
  t: { type: "toggle-left-mode" },
  p: { type: "toggle-work-area" },
  q: { type: "close" },
  "?": { type: "help" },
  ":": { type: "palette" },
};

const G_KEYS: Readonly<Record<string, KeyNavCommand>> = {
  g: { type: "edge", to: "start" },
  d: { type: "work-tab", tab: "board" },
  f: { type: "work-tab", tab: "files" },
  s: { type: "work-tab", tab: "git" },
  t: { type: "file-tab", dir: 1 },
  T: { type: "file-tab", dir: -1 },
};

/**
 * ノーマルモードで押されたキーを指示に直す。
 *
 * - 修飾キーつきの操作はブラウザに任せる (Ctrl+d / Ctrl+u の半ページ送りだけ受け取る)
 * - Enter・Tab・矢印などの名前つきのキーも任せる。フォーカスのある行やボタンが、
 *   既にそのキーで動くため (Enter を二重に効かせない)
 * - 文字のキーは、割り当てが無くても受け取る (文字が入力されたり、ページ内検索が
 *   開いたりしないように)
 */
export function resolveKey(pending: string, event: KeyLike): KeyNavResolution {
  if (event.metaKey || event.altKey) return { pending: "", handled: false };
  if (event.ctrlKey) {
    if (event.key === "d") {
      return { command: { type: "page", dir: 1 }, pending: "", handled: true };
    }
    if (event.key === "u") {
      return { command: { type: "page", dir: -1 }, pending: "", handled: true };
    }
    return { pending: "", handled: false };
  }
  if (event.key === "Escape") {
    return { command: { type: "cancel" }, pending: "", handled: true };
  }
  // Shift などの修飾キー単体は、打ちかけを消さない (`gT` の Shift)
  if (event.key.length !== 1) return { pending, handled: false };

  if (pending === "g") {
    return { command: G_KEYS[event.key], pending: "", handled: true };
  }
  if (event.key === "g") return { pending: "g", handled: true };
  return { command: SINGLE_KEYS[event.key], pending: "", handled: true };
}

/** キーの一覧 (`?`) に出す行 */
export const KEYNAV_HELP: ReadonlyArray<{
  title: string;
  rows: ReadonlyArray<readonly [keys: string, what: string]>;
}> = [
  {
    title: "モード",
    rows: [
      ["Ctrl+;", "ノーマルモードに入る / 出る"],
      ["i", "入力へ (端末 / 会話の入力欄)"],
      [":", "名前で探して実行する (セッション・ファイル・図・コマンド)"],
      ["?", "この一覧"],
    ],
  },
  {
    title: "場所とその中",
    rows: [
      ["h / l", "サイドバー ⇄ 左のパネル ⇄ 作業エリア"],
      ["j / k", "上下に動く (セッション・ツリー・コミット・会話・図)"],
      ["Enter", "選んでいるものを開く"],
      ["gg / G", "先頭 / 末尾"],
      ["Ctrl+d / Ctrl+u", "半ページ送る"],
    ],
  },
  {
    title: "どこでも",
    rows: [
      ["J / K", "次 / 前のセッション"],
      ["n", "次の「あなたの番」のセッション"],
      ["t", "端末 ⇄ 会話"],
      ["p", "作業エリアを開閉"],
      ["gd / gf / gs", "図 / ファイル / Git のタブ"],
      ["gt / gT", "次 / 前のファイルタブ"],
      ["q", "ピークを閉じる (無ければ作業エリア)"],
    ],
  },
];
