/**
 * テキストをクリップボードへ書く。書けたら true。
 *
 * navigator.clipboard は http の LAN アクセスや古い環境では存在せず、
 * 存在しても権限で reject されうる。呼び出し側はどちらも「書けなかった」として
 * 同じ失敗表示に落とせるよう、真偽値に畳んで返す。
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  const clipboard = navigator.clipboard;
  if (typeof clipboard?.writeText !== "function") return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
