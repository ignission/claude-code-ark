/**
 * doc 型ボードの本文を人間がその場で編集できるようにする注入レイヤ。
 *
 * graph の diagram-harness.ts とは別の注入文字列にする。harness の 128KiB guard
 * (diagram-harness.test.ts:187) は injectHarness の出力だけを測っており、
 * doc 編集層をそこへ混ぜると graph の残り枠を食うため。
 *
 * モード切替は置かない。コメント層は選択時に浮くボタンを出す形 (updateSelectionAdd)
 * なので、選択がそのままコメントになるわけではなく contenteditable と衝突しない。
 */

import { MODEL_SCRIPT_ID } from "./diagram-file.js";
import { createCachedMinifier } from "./injected-minify.js";

export const DIAGRAM_DOC_EDITOR_MARKER = "ark-diagram-doc-editor";

export const DOC_EDITOR_LAYER = `<script id="${DIAGRAM_DOC_EDITOR_MARKER}" data-ark-harness-ui="1">
(function(){
  var MODEL_SCRIPT_ID="${MODEL_SCRIPT_ID}";
  var port=null;
  var saveTimer=null;
  var bar=null;

  function modelScript(){return document.getElementById(MODEL_SCRIPT_ID);}

  function readModel(){
    var el=modelScript();
    if(!el)return null;
    try{return JSON.parse(el.textContent||"");}catch(e){return null;}
  }

  function writeModel(model){
    var el=modelScript();
    if(el)el.textContent=JSON.stringify(model);
  }

  // data-ark-id の入れ子は正規の構造（作図規約の階層 prefix）。編集可能にするのは
  // 他の data-ark-id を内包しない最内側の葉ブロックだけにする。祖先まで
  // contenteditable にすると、本文をクリックして全選択 → 削除するだけで
  // 複数ブロックが同時に消える上、入力イベントが祖先へもバブルして
  // 祖先の data-ark-author まで human に上書きしてしまう（#C-1）。
  // 副作用として、非葉ブロックの直下に地の文があってもそこは編集できないが、
  // 作図規約は本文を葉ブロックへ置く形なので許容する。
  function isLeafBlock(el){
    return !el.closest("[data-ark-harness-ui]")&&!el.querySelector("[data-ark-id]");
  }

  function blocks(){
    return Array.prototype.slice.call(document.querySelectorAll("[data-ark-id]"))
      .filter(isLeafBlock);
  }

  /** 送信用 HTML: 編集層の DOM と contenteditable を落とす */
  function submissionHtml(){
    var clone=document.documentElement.cloneNode(true);
    // コメント層は引用ハイライトの <span> と選択中クラスをブロック本文へ直接
    // 書き込む（data-ark-harness-ui は付かない。コメント層はこれまで読み取り専用の
    // 上に乗るだけだったので焼き付かなかったが、doc が編集可能になった今はここで
    // 剥がさないと autosave のたびにファイルへ残る）。
    // 展開の手順は comment layer 自身の clearHighlights と同じにする。
    clone.querySelectorAll('.ark-comment-highlight[data-ark-comment-owned="true"]').forEach(function(el){
      var parent=el.parentNode;
      el.replaceWith(document.createTextNode(el.textContent||""));
      if(parent&&parent.normalize)parent.normalize();
    });
    clone.querySelectorAll(".ark-comment-anchor-active").forEach(function(el){
      el.classList.remove("ark-comment-anchor-active");
      if(!el.classList.length)el.removeAttribute("class");
    });
    clone.querySelectorAll("[data-ark-harness-ui]").forEach(function(el){
      if(el.parentNode)el.parentNode.removeChild(el);
    });
    clone.querySelectorAll("[contenteditable]").forEach(function(el){
      el.removeAttribute("contenteditable");
    });
    clone.querySelectorAll("[data-ark-doc-wired]").forEach(function(el){
      el.removeAttribute("data-ark-doc-wired");
    });
    // サーバーが配信時に足す CSP meta を保存前に落とす（焼き付き防止）。
    clone.querySelectorAll('meta[http-equiv="Content-Security-Policy" i]').forEach(function(el){
      if(el.parentNode)el.parentNode.removeChild(el);
    });
    return "<!doctype html>"+String.fromCharCode(10)+clone.outerHTML;
  }

  function markDirty(){
    syncModelNodes();
    if(bar)bar.setAttribute("data-visible","true");
    clearTimeout(saveTimer);
    saveTimer=setTimeout(save,800);
  }

  function save(){
    if(!port)return;
    var model=readModel();
    if(!model)return;
    port.postMessage({type:"ark:diagram-autosave",model:model,html:submissionHtml()});
  }

  function submit(){
    if(!port)return;
    var model=readModel();
    if(!model)return;
    clearTimeout(saveTimer);
    port.postMessage({type:"ark:diagram-submit",model:model,html:submissionHtml()});
    if(bar)bar.setAttribute("data-visible","false");
  }

  /** 人間が触ったブロックへ human 印を付ける */
  function stampAuthor(el){
    if(!el||!el.getAttribute("data-ark-id"))return;
    el.setAttribute("data-ark-author","human");
  }

  function wire(){
    blocks().forEach(function(el){
      if(el.getAttribute("data-ark-doc-wired"))return;
      el.setAttribute("data-ark-doc-wired","1");
      el.contentEditable="true";
    });
  }

  // 個別の anchor へ listener を付けるのではなく document へ1つだけ付け、
  // event.target から最も近い data-ark-id を1個だけ stamp する（delegated）。
  // 葉だけが contenteditable なので、入力の実際の発生源から closest すれば
  // 常にその葉自身に解決する。将来ブロックが増減しても listener の張り直しが要らない。
  function handleInput(event){
    var target=event&&event.target;
    var el=target&&target.closest?target.closest("[data-ark-id]"):null;
    if(!el||!el.getAttribute("data-ark-doc-wired"))return;
    stampAuthor(el);
    markDirty();
  }

  // execCommand は非推奨だが insertText の代替が無い。false 返却/例外時に
  // そのまま何もしないと、preventDefault 済みなので貼り付け内容が無言で
  // 消える（今回の Critical と同じ型の事故）。Selection API で直接テキスト
  // ノードを挿入するフォールバックへ落とし、それも失敗したときだけ諦めて
  // 警告を残す。
  function insertPlainText(text){
    var inserted=false;
    try{inserted=document.execCommand("insertText",false,text);}catch(e){inserted=false;}
    if(inserted)return;
    try{
      var selection=window.getSelection();
      if(!selection||selection.rangeCount===0)throw new Error("no selection");
      var range=selection.getRangeAt(0);
      range.deleteContents();
      var node=document.createTextNode(text);
      range.insertNode(node);
      range.setStartAfter(node);
      range.setEndAfter(node);
      selection.removeAllRanges();
      selection.addRange(range);
    }catch(e){
      console.warn("ark: 貼り付け/ドロップしたテキストを挿入できませんでした",e);
    }
  }

  // 他サイトからの貼り付け・ドロップは inline style / class / img / a 等を
  // 本文へ持ち込み、そのままファイルへ永続化されてしまう。plain text だけを
  // 挿入する。
  function handlePaste(event){
    var target=event&&event.target;
    var el=target&&target.closest?target.closest("[data-ark-id]"):null;
    if(!el||!el.getAttribute("data-ark-doc-wired"))return;
    event.preventDefault();
    var clipboard=event.clipboardData||window.clipboardData;
    insertPlainText(clipboard?clipboard.getData("text/plain"):"");
  }

  function handleDrop(event){
    var target=event&&event.target;
    var el=target&&target.closest?target.closest("[data-ark-id]"):null;
    if(!el||!el.getAttribute("data-ark-doc-wired"))return;
    event.preventDefault();
    var data=event.dataTransfer;
    insertPlainText(data?data.getData("text/plain"):"");
  }

  function syncModelNodes(){}

  function buildBar(){
    var style=document.createElement("style");
    style.setAttribute("data-ark-harness-ui","1");
    style.textContent='#ark-doc-bar{display:none}#ark-doc-bar[data-visible="true"]{display:block}[data-ark-id][contenteditable="true"]:focus{outline:2px solid #38bdf8;outline-offset:2px}';
    document.head.appendChild(style);

    bar=document.createElement("div");
    bar.id="ark-doc-bar";
    bar.setAttribute("data-ark-harness-ui","1");
    bar.setAttribute("data-visible","false");
    bar.style.cssText="position:fixed;right:12px;bottom:12px;z-index:9";
    var send=document.createElement("button");
    send.textContent="変更を送る";
    send.style.cssText="font:inherit;padding:6px 12px;border-radius:6px;border:1px solid #475569;background:#1e293b;color:#e2e8f0;cursor:pointer";
    send.addEventListener("click",submit);
    bar.appendChild(send);
    document.body.appendChild(bar);
  }

  window.addEventListener("message",function(event){
    if(port||!event.data||event.data.type!=="ark:diagram-init")return;
    if(!event.ports||!event.ports[0])return;
    port=event.ports[0];
    port.start();
  });

  function start(){
    buildBar();
    wire();
    document.addEventListener("input",handleInput);
    document.addEventListener("paste",handlePaste);
    document.addEventListener("drop",handleDrop);
    document.addEventListener("ark:doc-sync",syncModelNodes);
  }
  if(document.readyState==="loading"){
    document.addEventListener("DOMContentLoaded",start);
  }else{
    start();
  }
})();
</script>`;

const scriptContentStart = DOC_EDITOR_LAYER.indexOf(">") + 1;
const scriptContentEnd = DOC_EDITOR_LAYER.lastIndexOf("</script>");
const minify = createCachedMinifier(
  DOC_EDITOR_LAYER.slice(scriptContentStart, scriptContentEnd),
  "js"
);

function minifiedLayer(): string {
  return (
    DOC_EDITOR_LAYER.slice(0, scriptContentStart) +
    minify() +
    DOC_EDITOR_LAYER.slice(scriptContentEnd)
  );
}

// マーカー文字列の bare な includes() だけだと、doc の本文にたまたま
// "ark-diagram-doc-editor" という語が書かれているだけで、以後その board は
// 無言で二度と注入されなくなる。comment layer（injectDiagramCommentLayer）と
// 同じ堅さにする: 実際に注入済みの <script id="..."> タグがあるかで判定する。
const INJECTED_SCRIPT_RE = new RegExp(
  `<script[^>]*\\bid=["']${DIAGRAM_DOC_EDITOR_MARKER}["']`,
  "i"
);

export function injectDiagramDocEditor(html: string): string {
  if (INJECTED_SCRIPT_RE.test(html)) return html;
  const layer = minifiedLayer();
  const closing = html.toLowerCase().lastIndexOf("</body>");
  if (closing === -1) return html + layer;
  return html.slice(0, closing) + layer + html.slice(closing);
}
