/**
 * focus-input - 端末の窓を開閉したあとのフォーカスの移し先を決める
 *
 * 全セッションぶんの SplitViewPane が常時マウントされているので、要素は必ず
 * 「見えているもの」から探す (`hidden` の祖先を持たないもの)。
 */

function visibleOne<T extends Element = HTMLElement>(
  root: ParentNode,
  selector: string
): T | null {
  return (
    [...root.querySelectorAll<T>(selector)].find(
      element => element.closest(".hidden, [hidden]") === null
    ) ?? null
  );
}

/**
 * 端末の窓が開いていれば端末、閉じていれば会話の入力欄にフォーカスを置く。
 * 窓が開いているのに端末がフォーカスを受けられないとき (iframeがまだ無い、ファイルの
 * タブを見ていて隠れている) は、窓の枠に置く。会話の入力欄には置かない
 * (窓の後ろの入力欄に打ったキーが入り、Enterで送られてしまうため)
 */
export function focusInput(root: ParentNode): void {
  const terminal = visibleOne<HTMLIFrameElement>(
    root,
    'iframe[data-focus-target="terminal"]'
  );
  if (terminal) {
    // ttyd は同じ出どころなので、中の xterm (`window.term`) へ直接フォーカスを渡せる
    const term = (
      terminal.contentWindow as unknown as {
        term?: { focus?: () => void };
      } | null
    )?.term;
    terminal.focus();
    term?.focus?.();
    if (terminal.ownerDocument.activeElement === terminal) return;
  }
  const terminalWindow = visibleOne(
    root,
    '[data-focus-target="terminal-window"]'
  );
  if (terminalWindow) {
    terminalWindow.focus();
    return;
  }
  visibleOne(root, 'textarea[data-focus-target="chat-input"]')?.focus();
}
