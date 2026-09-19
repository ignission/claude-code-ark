/**
 * 「変更を送る」で会話へ流す文面を組む。
 *
 * doc は本文 HTML が正準 source であり、保存時に label 抜粋を本文から作り直すため
 * (diagram-doc-label.ts)、describeModelDiff を通すと本文の還流と「改名」行が
 * 二重に出る。そのため doc はブロック本文の経路だけを使う。
 *
 * 部分的に「改名」だけを抑えないのは、label 再生成が全保存で走るため。
 * 抑止を部分的にすると、この機能が入って最初の保存で古い label からの
 * 「改名」通知が一斉に噴き出す。
 */

import { describeModelDiff } from "./diagram-diff.js";
import { type DocBlock, extractDocBlocks } from "./diagram-doc-blocks.js";
import { describeDocBodyChanges } from "./diagram-doc-notice.js";
import type { DiagramModel } from "./diagram-model.js";

export interface SubmitNoticeInput {
  relPath: string;
  baselineModel: DiagramModel;
  savedModel: DiagramModel;
  /** 最後に通知できた時点のブロック本文。未登録なら undefined */
  baselineBodies: Map<string, DocBlock> | undefined;
  /** 実際に書いたファイル本文 (配信用の注入を含まない生 HTML) */
  savedHtmlRaw: string;
}

export interface SubmitNotice {
  lines: string[];
  message: string | null;
  /** 通知が成功したときに次の baseline として覚える本文。graph では空 */
  savedBodies: Map<string, DocBlock>;
}

/** 行を箇条書きに畳む。本文は describeDocBodyChanges / describeModelDiff で無害化済み */
function bullets(lines: string[]): string {
  return lines.map(line => `- ${line}`).join("\n");
}

export function buildSubmitNotice(input: SubmitNoticeInput): SubmitNotice {
  if (input.savedModel.type === "doc") {
    const savedBodies = extractDocBlocks(input.savedHtmlRaw);
    const changes =
      input.baselineBodies === undefined
        ? { lines: [], allHuman: false }
        : describeDocBodyChanges(input.baselineBodies, savedBodies);
    const { lines } = changes;
    // 還流するのは「人間が編集したブロック」ではなく「baseline から変わった
    // ブロック」なので、別セッションの Claude の出力や worktree 外からの
    // 書き換えも混ざりうる。人間の決定だという主張は、実際に本文へ
    // data-ark-author="human" が付いているときだけ述べる (#319)
    const attestation = changes.allHuman
      ? "\n（いずれも human として記録済み）"
      : "";
    const message =
      lines.length === 0
        ? null
        : `図の本文を編集しました（${input.relPath}）:\n${bullets(lines)}${attestation}`;
    return { lines, message, savedBodies };
  }

  const lines = describeModelDiff(input.baselineModel, input.savedModel);
  const message =
    lines.length === 0
      ? null
      : `図を編集しました（${input.relPath}）:\n${bullets(lines)}`;
  return { lines, message, savedBodies: new Map() };
}
