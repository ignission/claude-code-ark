/**
 * MessageShortcutMenu - メッセージショートカットの表示用ヘルパー
 *
 * ショートカットの送信と管理は、PC・モバイルとも MessageShortcutQuickButton
 * (バーの1タップのボタン) から行う。ここには項目の1行表示に使う previewOf だけを置く。
 */

/** 表示用に message の先頭行を 40 字で切り詰める（label 廃止に伴う代替） */
export function previewOf(message: string): string {
  const firstLine = message.split("\n")[0];
  return firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine;
}
