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
}

/** サーバーが受け取るURLの長さの上限 */
const URL_MAX_LENGTH = 2048;
const NEW_TAB_TITLE = "新しいタブ";
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
 * サーバーが知らせたURLに戻る。
 *
 * この入力欄は、リモートへキーを送る透明のtextareaとは別の要素なので、ここで打った
 * キーはリモートのページに届かない。
 *
 * タブの並びは、タブが2つ以上のときだけ出す。1つのときは、新しいタブのボタンだけを
 * ツールバーの右端に置き、画面の高さを使わない。タブは中ボタンでも閉じられる。
 */
export function BrowserToolbar({
  page,
  tabs,
  activeId,
  disabled = false,
  onSend,
}: BrowserToolbarProps) {
  const [focused, setFocused] = useState(false);
  const [draft, setDraft] = useState("");
  // フォーカスした直後のmouseupは、全体の選択を解いてしまうので止める
  const keepSelectionRef = useRef(false);
  const url = page?.url ?? "";
  const loading = page?.loading ?? false;
  const showTabs = tabs.length >= 2;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (draft.trim()) onSend({ t: "nav", type: "goto", url: draft });
      e.currentTarget.blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.currentTarget.blur();
    }
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
          <div
            role="tablist"
            aria-label="タブ"
            className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto"
          >
            {tabs.map(tab => {
              const title = tabTitle(tab);
              const active = tab.id === activeId;
              const close = () =>
                onSend({ t: "tab", type: "close", id: tab.id });
              return (
                <div
                  key={tab.id}
                  className={cn(
                    "flex h-7 min-w-16 max-w-48 flex-1 basis-0 items-center rounded-lg text-xs",
                    active
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                  )}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={active}
                    title={title}
                    disabled={disabled}
                    onClick={() =>
                      onSend({ t: "tab", type: "activate", id: tab.id })
                    }
                    // 中ボタンの既定の動作 (自動スクロール) を止める
                    onMouseDown={e => {
                      if (e.button === 1) e.preventDefault();
                    }}
                    onAuxClick={e => {
                      if (e.button !== 1) return;
                      e.preventDefault();
                      close();
                    }}
                    className="h-full min-w-0 flex-1 truncate rounded-lg pr-1 pl-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none"
                  >
                    {title}
                  </button>
                  <button
                    type="button"
                    aria-label={`タブを閉じる: ${title}`}
                    title={`タブを閉じる: ${title}`}
                    disabled={disabled}
                    onClick={close}
                    className="mr-1 inline-flex size-5 shrink-0 items-center justify-center rounded outline-none hover:bg-background hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-40"
                  >
                    <X className="size-3" />
                  </button>
                </div>
              );
            })}
          </div>
          {newTabButton}
        </div>
      )}
    </div>
  );
}
