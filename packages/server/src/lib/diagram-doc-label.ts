/**
 * doc の model `label` を本文から作り直す。
 *
 * doc は本文 HTML が正準 source で、model の label は検索と一覧表示のための
 * 抜粋にすぎない。人間が本文を直すと抜粋がずれ、board_comments が返す
 * anchorText が嘘になるので、保存経路で1回だけ作り直す。
 */

import { extractDocBlocks, isContainerBlock } from "./diagram-doc-blocks.js";
import type { DiagramModel } from "./diagram-model.js";

const LABEL_MAX_LENGTH = 80;
const LABEL_ELLIPSIS = "…";

/** 末尾を省略記号に置き換えて LABEL_MAX_LENGTH (コードポイント数) 以内に切り詰める */
function excerpt(text: string): string {
  const characters = Array.from(text);
  if (characters.length <= LABEL_MAX_LENGTH) return text;
  return characters.slice(0, LABEL_MAX_LENGTH - 1).join("") + LABEL_ELLIPSIS;
}

export function refreshDocLabels(
  model: DiagramModel,
  html: string
): DiagramModel {
  if (model.type !== "doc") return model;
  const blocks = extractDocBlocks(html);
  return {
    ...model,
    nodes: model.nodes.map(node => {
      const block = blocks.get(node.id);
      // 容器 (子孫に別の data-ark-id を持つ要素) の text は子孫本文の連結
      // (diagram-doc-blocks.ts の textOf)。それで label を上書きすると、
      // 人間が書いた見出し的な label が子孫の地の文のこだまで静かに消える
      // (describeDocBodyChanges が容器を報告から外すのと同じ理由)
      if (!block || block.text === "" || isContainerBlock(block.html)) {
        return node;
      }
      return { ...node, label: excerpt(block.text) };
    }),
  };
}
