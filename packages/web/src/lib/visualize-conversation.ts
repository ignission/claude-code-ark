/** 「会話を図解」ボタンが現在の Claude セッションへ送るプロンプトを組み立てる。
 *  返答に ```mermaid ブロックが含まれれば Phase 1 の MermaidBlock が描画する。
 *  プロンプト自体がチャットに user メッセージとして表示されるため簡潔にする。 */
export function buildVisualizeConversationPrompt(): string {
  return (
    "ここまでの会話の要点を図解してください。" +
    "内容に最も合う mermaid の図種（flowchart / sequenceDiagram / classDiagram / stateDiagram など）を選び、" +
    "```mermaid コードブロックで返してください。ノードのラベルは簡潔に。"
  );
}
