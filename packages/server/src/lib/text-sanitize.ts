/**
 * 生成文 (diagram-diff.ts / diagram-doc-notice.ts が tmux 越しの対話版 Claude へ
 * 送る文) から除去すべき制御文字の判定。
 *
 * 「tmux 送出前に何を落とすか」はこの2箇所で共有すべき不変条件であり、
 * 別々に持つと片方だけ更新されて静かに乖離しうるため、判定だけをここへ切り出す
 * (truncate や空白畳み込みの挙動は用途ごとに異なるため寄せない)。
 */

/**
 * C0 制御文字（0-31）・DEL（127）・C1 制御文字（128-159、改行扱いされうる
 * NEL U+0085 を含む）に加え、C0 ではないが改行として描画されうる
 * U+2028 LINE SEPARATOR / U+2029 PARAGRAPH SEPARATOR も対象にする
 * （1行封じ込めの注入対策を迂回させないため）
 */
export function isControlCodePoint(codePoint: number): boolean {
  return (
    codePoint <= 31 ||
    (codePoint >= 127 && codePoint <= 159) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029
  );
}
