import type {
  BrowserClientMessage,
  BrowserPageInfo,
  BrowserTabInfo,
} from "@ark/shared";
import { ArrowLeft, ArrowRight, Plus, RotateCw, X } from "lucide-react";
import type React from "react";
import { useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface BrowserToolbarProps {
  /** いま映しているタブの状態。まだ届いていなければ `null` */
  page: BrowserPageInfo | null;
  tabs: BrowserTabInfo[];
  activeId: string | null;
  /** つながっていない間は `true`。どの操作も受けない */
  disabled?: boolean;
  onSend: (msg: BrowserClientMessage) => void;
  /**
   * URLの入力欄で、EnterかEscapeを押したあと。入力欄のフォーカスを外してから呼ぶ。
   * フォーカスの行き先は親が決める
   */
  onUrlDone?: () => void;
}

/** サーバーが受け取るURLの長さの上限 */
const URL_MAX_LENGTH = 2048;
/** IMEが受け取ったキーの `keyCode` */
const IME_KEYCODE = 229;
const NEW_TAB_TITLE = "新しいタブ";
const TAB_SELECTOR = '[role="tab"]';
const ICON_BUTTON_CLASS =
  "inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-40";

function tabTitle(tab: BrowserTabInfo): string {
  return tab.title || tab.url || NEW_TAB_TITLE;
}

interface IconButtonProps {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

/** アイコンだけのボタン。名前を読み上げとツールチップの両方に出す */
function IconButton({ label, disabled, onClick, children }: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={ICON_BUTTON_CLASS}
    >
      {children}
    </button>
  );
}

/**
 * ブラウザ機能のツールバーとタブの並び。サーバーのChromiumはヘッドレスで、自分の
 * ツールバーを持たないので、Arkが描く。
 *
 * URLの入力欄は、フォーカスが無い間はサーバーが知らせたURLを表示し、フォーカス中は
 * 利用者の入力を保つ (ページの状態は読み込みの途中で何度も届くので、届くたびに上書き
 * すると打てない)。Enterで入力をそのまま送る。スキームの補完と、開けるURLかどうかの
 * 検査は、サーバーが行う。Escapeは入力を捨てる。どちらもフォーカスを外すので、表示は
 * サーバーが知らせたURLに戻る。外したあとのフォーカスの行き先は、親に任せる
 * (`onUrlDone`)。親は、続けて打ったキーがページに届くよう、canvasの入力欄へ移す。
 * 変換中のEnterとEscape (`isComposing` か `keyCode === 229`) は、変換の確定と取り消しの
 * キーなので、送りもフォーカスを外しもしない。
 *
 * この入力欄は、リモートへキーを送る透明のtextareaとは別の要素なので、ここで打った
 * キーはリモートのページに届かない。
 *
 * タブの並びは、タブが2つ以上のときだけ出す。1つのときは、新しいタブのボタンだけを
 * ツールバーの右端に置き、画面の高さを使わない。
 *
 * `tablist` の直接の子は、タブ (`role="tab"`) だけにする。タブを閉じるボタンは、タブの
 * 中にも `tablist` の中にも置かない (タブの中身は、読み上げでは文字としてだけ扱われ、
 * 中のボタンは操作できない)。閉じるボタンは `tablist` の外に並べ、どのタブのものかを
 * 名前 (`aria-label`) で示し、CSSの `order` でそのタブの右端に重ねて見せる。`tablist` は
 * `display: contents` にして、タブと閉じるボタンを同じ並びの項目にする。
 *
 * Tabキーで止まるのは、映しているタブの1つだけ。タブの間は左右の矢印で移り (端からは
 * 反対の端へ回る)、EnterかSpaceで切り替える。矢印で移っただけでは切り替えない (切り替えは
 * リモートの画面を替えるので、通り過ぎるタブを1つずつ映さない)。タブの上のDeleteと、
 * 中ボタンでも閉じられる。閉じるボタンはTabキーでは止めない。
 */
export function BrowserToolbar({
  page,
  tabs,
  activeId,
  disabled = false,
  onSend,
  onUrlDone,
}: BrowserToolbarProps) {
  const [focused, setFocused] = useState(false);
  const [draft, setDraft] = useState("");
  // フォーカスした直後のmouseupは、全体の選択を解いてしまうので止める
  const keepSelectionRef = useRef(false);
  const url = page?.url ?? "";
  const loading = page?.loading ?? false;
  const showTabs = tabs.length >= 2;
  // Tabキーで止めるタブ。映しているタブが一覧に無ければ、最初のタブ
  const tabStopId = tabs.some(tab => tab.id === activeId)
    ? activeId
    : tabs[0]?.id;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter" && e.key !== "Escape") return;
    if (e.nativeEvent.isComposing || e.keyCode === IME_KEYCODE) return;
    e.preventDefault();
    if (e.key === "Enter" && draft.trim()) {
      onSend({ t: "nav", type: "goto", url: draft });
    }
    e.currentTarget.blur();
    onUrlDone?.();
  };

  const closeTab = (id: string) => onSend({ t: "tab", type: "close", id });

  const handleTabKeyDown = (
    e: React.KeyboardEvent<HTMLButtonElement>,
    index: number
  ) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Delete") {
      return;
    }
    e.preventDefault();
    const siblings = [
      ...(e.currentTarget.parentElement?.querySelectorAll<HTMLElement>(
        TAB_SELECTOR
      ) ?? []),
    ];
    if (e.key === "Delete") {
      closeTab(tabs[index].id);
      // 閉じたタブの要素は消えるので、先に隣へ移しておく
      (siblings[index + 1] ?? siblings[index - 1])?.focus();
      return;
    }
    const step = e.key === "ArrowRight" ? 1 : -1;
    siblings[(index + step + siblings.length) % siblings.length]?.focus();
  };

  const newTabButton = (
    <IconButton
      label={NEW_TAB_TITLE}
      disabled={disabled}
      onClick={() => onSend({ t: "tab", type: "new" })}
    >
      <Plus className="size-3.5" />
    </IconButton>
  );

  return (
    <div className="shrink-0 border-b border-border bg-background">
      <div className="flex h-9 items-center gap-0.5 px-1">
        <IconButton
          label="戻る"
          disabled={disabled || !page?.canGoBack}
          onClick={() => onSend({ t: "nav", type: "back" })}
        >
          <ArrowLeft className="size-3.5" />
        </IconButton>
        <IconButton
          label="進む"
          disabled={disabled || !page?.canGoForward}
          onClick={() => onSend({ t: "nav", type: "forward" })}
        >
          <ArrowRight className="size-3.5" />
        </IconButton>
        <IconButton
          label={loading ? "読み込みを中止" : "再読み込み"}
          disabled={disabled}
          onClick={() =>
            onSend({ t: "nav", type: loading ? "stop" : "reload" })
          }
        >
          {loading ? (
            <X className="size-3.5" />
          ) : (
            <RotateCw className="size-3.5" />
          )}
        </IconButton>
        <Input
          type="text"
          inputMode="url"
          enterKeyHint="go"
          aria-label="URL"
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          maxLength={URL_MAX_LENGTH}
          disabled={disabled}
          value={focused ? draft : url}
          onChange={e => setDraft(e.target.value)}
          onFocus={e => {
            setDraft(url);
            setFocused(true);
            e.currentTarget.select();
            keepSelectionRef.current = true;
          }}
          onBlur={() => {
            setFocused(false);
            keepSelectionRef.current = false;
          }}
          onMouseUp={e => {
            if (keepSelectionRef.current) e.preventDefault();
            keepSelectionRef.current = false;
          }}
          onKeyDown={handleKeyDown}
          className="mx-1 h-7 min-w-0 flex-1 rounded-lg border-transparent bg-muted/60 px-2.5 text-base shadow-none focus-visible:bg-background focus-visible:ring-2 md:text-[13px] dark:bg-muted/60"
        />
        {!showTabs && newTabButton}
      </div>
      {showTabs && (
        <div className="flex h-8 items-center gap-0.5 px-1 pb-1">
          <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
            <div role="tablist" aria-label="タブ" className="contents">
              {tabs.map((tab, index) => {
                const title = tabTitle(tab);
                const active = tab.id === activeId;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    tabIndex={tab.id === tabStopId ? 0 : -1}
                    title={title}
                    disabled={disabled}
                    style={{ order: index * 2 }}
                    onClick={() =>
                      onSend({ t: "tab", type: "activate", id: tab.id })
                    }
                    onKeyDown={e => handleTabKeyDown(e, index)}
                    // 中ボタンの既定の動作 (自動スクロール) を止める
                    onMouseDown={e => {
                      if (e.button === 1) e.preventDefault();
                    }}
                    onAuxClick={e => {
                      if (e.button !== 1) return;
                      e.preventDefault();
                      closeTab(tab.id);
                    }}
                    // 右の余白は、重ねて置く閉じるボタンの分
                    className={cn(
                      "h-7 min-w-16 max-w-48 flex-1 basis-0 truncate rounded-lg pr-7 pl-2.5 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none",
                      active
                        ? "bg-muted text-foreground"
                        : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                    )}
                  >
                    {title}
                  </button>
                );
              })}
            </div>
            {tabs.map((tab, index) => {
              const label = `タブを閉じる: ${tabTitle(tab)}`;
              return (
                <button
                  key={tab.id}
                  type="button"
                  aria-label={label}
                  title={label}
                  tabIndex={-1}
                  disabled={disabled}
                  style={{ order: index * 2 + 1 }}
                  onClick={() => closeTab(tab.id)}
                  // 左の負の余白で、直前のタブの右端に重ねる (並びの間隔の2pxを含む)
                  className={cn(
                    "relative mr-1 -ml-[26px] inline-flex size-5 shrink-0 items-center justify-center rounded outline-none hover:bg-background hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-40",
                    tab.id === activeId
                      ? "text-foreground"
                      : "text-muted-foreground"
                  )}
                >
                  <X className="size-3" />
                </button>
              );
            })}
          </div>
          {newTabButton}
        </div>
      )}
    </div>
  );
}
