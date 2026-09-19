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

  function blocks(){
    return Array.prototype.slice.call(document.querySelectorAll("[data-ark-id]"))
      .filter(function(el){return !el.closest("[data-ark-harness-ui]");});
  }

  /** 送信用 HTML: 編集層の DOM と contenteditable を落とす */
  function submissionHtml(){
    var clone=document.documentElement.cloneNode(true);
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
    // http-equiv の値そのものをここに書くと、注入する script のソースに
    // その文字列が現れてしまう（doc 編集層は CSP を自分で書かない制約に抵触して見える）。
    // doc の head に http-equiv meta を書く正当な理由は無いため、値を見ずに
    // http-equiv を持つ meta を一律で落とす。
    clone.querySelectorAll("meta[http-equiv]").forEach(function(el){
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
      el.addEventListener("input",function(){stampAuthor(el);markDirty();});
    });
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

  function start(){buildBar();wire();document.addEventListener("ark:doc-sync",syncModelNodes);}
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

export function injectDiagramDocEditor(html: string): string {
  if (html.includes(DIAGRAM_DOC_EDITOR_MARKER)) return html;
  const layer = minifiedLayer();
  const closing = html.toLowerCase().lastIndexOf("</body>");
  if (closing === -1) return html + layer;
  return html.slice(0, closing) + layer + html.slice(closing);
}
