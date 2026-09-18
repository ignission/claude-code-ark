/**
 * clipboard-images - クリップボードから画像を読み取り、Fileの配列にする。
 *
 * TerminalPane / MobileSessionView / SplitChatPane の3箇所に同じ読み取りループが
 * あったので、ここへ寄せた。トースト・アップロード後処理は呼び出し側で
 * 違う (端末は確認ダイアログ、会話は `@path` を入力欄へ) ので、ここでは読み取りと
 * File化だけをする。`navigator.clipboard.read()` が失敗したときはそのまま
 * 呼び出し側へ伝える (空振りと読み取り失敗を呼び出し側がトーストで出し分けるため)
 */
export async function readClipboardImages(): Promise<File[]> {
  const clipboardItems = await navigator.clipboard.read();
  const files: File[] = [];
  for (const item of clipboardItems) {
    const imageType = item.types.find(type => type.startsWith("image/"));
    if (!imageType) continue;
    const blob = await item.getType(imageType);
    const ext = imageType.split("/")[1] || "png";
    files.push(new File([blob], `pasted-image.${ext}`, { type: imageType }));
  }
  return files;
}
