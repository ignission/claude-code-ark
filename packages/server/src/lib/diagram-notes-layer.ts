import { DIAGRAM_NOTE_HEIGHT, DIAGRAM_NOTE_WIDTH } from "@ark/shared";
import { createCachedMinifier } from "./injected-minify.js";

export const DIAGRAM_NOTES_LAYER_MARKER = "ark-diagram-notes-layer";

/**
 * ボードの上に付箋と枠を描き、人の操作を親へ渡す層。付箋の決まりは diagram-notes.ts にある。
 *
 * - **描くのは親から届いた付箋だけ** (`ark:diagram-notes`)。保存はしない。人が足す、動かす、
 *   書く、消すと、その操作を1つずつ親へ送る (`ark:diagram-note-op`)。親がサーバーへ渡す
 * - **図の CSS に巻き込まれないよう、Shadow DOM の中に描く。** 図は Claude が自由に書くので、
 *   `div` や `button` への指定が付箋に当たりうる
 * - **図の邪魔をしない。** 層の入れ物は大きさを持たず、付箋のある場所だけが操作を受ける。
 *   付箋の無いところは、今までどおり図のリンクやスクロールが働く
 * - **触っている付箋は、届いた内容で上書きしない。** 動かしている最中の位置と、書いている
 *   最中の文は、手元のものを保つ (届くのは、自分の操作が反映される前の内容かもしれない)
 * - **文は打つたびに少し待って送る。** Claude が図を書き直すと文書ごと作り直されるので、
 *   フォーカスが外れるまで待つと、書きかけが消える
 * - **Enter には何も割り当てない。** 日本語の変換の確定と取り合わない。付箋の中の改行になる
 * - **保存できなかった付箋を、置いたままにしない。** 足した付箋は、保存の結果を待たずに描く。
 *   サーバーが断ったら (上限、壊れたファイルなど)、親が `ark:diagram-note-drop` で知らせ、消す
 * - 付箋を足す位置は、いま見えている範囲の中央。親のボタンから `ark:diagram-note-add` で
 *   頼まれる (図の上のダブルクリックは、タッチで使えず、図の文字の選択とも取り合う)
 *
 * port の扱いはリンク層 (diagram-link-layer.ts) と同じ。
 */
export const NOTES_LAYER = `<script id="${DIAGRAM_NOTES_LAYER_MARKER}">
(function(){
  "use strict";
  var W=${DIAGRAM_NOTE_WIDTH};
  var H=${DIAGRAM_NOTE_HEIGHT};
  var SEND_DELAY=400;
  var CSS=""
    +".frame{position:absolute;box-sizing:border-box;border:2px dashed #9aa3af;border-radius:12px;pointer-events:none}"
    +".frame b{position:absolute;left:12px;top:8px;max-width:calc(100% - 24px);overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font:600 13px/1.4 system-ui,-apple-system,'Hiragino Sans','Noto Sans JP',sans-serif;color:#374151}"
    +".note{position:absolute;box-sizing:border-box;width:"+W+"px;min-height:"+H+"px;background:#ffe680;color:#1f2328;border-radius:3px;box-shadow:0 2px 5px rgba(0,0,0,.2);font:13px/1.4 system-ui,-apple-system,'Hiragino Sans','Noto Sans JP',sans-serif}"
    +".note.claude{background:#cfe4ff}"
    +".note.drag{box-shadow:0 8px 18px rgba(0,0,0,.28);z-index:1}"
    +".grip{display:flex;align-items:center;justify-content:space-between;height:20px;padding:0 2px 0 8px;background:#f2cf3d;border-radius:3px 3px 0 0;cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none;font-size:10px;font-weight:700;color:#1d4f91}"
    +".note.claude .grip{background:#8dbcf5}"
    +".close{all:unset;box-sizing:border-box;width:20px;height:20px;line-height:20px;text-align:center;font-size:14px;color:#1f2328;opacity:.45;cursor:pointer}"
    +".close:hover,.close:focus-visible{opacity:1}"
    +".text{min-height:"+(H-20)+"px;box-sizing:border-box;padding:6px 9px 9px;outline:none;white-space:pre-wrap;overflow-wrap:anywhere;cursor:text}"
    +".note.claude .text{cursor:default}";
  var port=null;
  var host=null;
  var root=null;
  var frameBox=null;
  var noteBox=null;
  var elements={};
  var timers={};
  var dragging=null;

  function mount(){
    if(host)return;
    // The host sits in the board's own document, so the board's CSS can reach it.
    // A tag of its own and inline !important keep rules like div{border:...} off it
    host=document.createElement("ark-notes");
    host.setAttribute("data-ark-layer","notes");
    host.style.cssText="all:initial!important;display:block!important;position:absolute!important;left:0!important;top:0!important;width:0!important;height:0!important;z-index:2147483000!important;";
    root=host.attachShadow({mode:"open"});
    var style=document.createElement("style");
    style.textContent=CSS;
    frameBox=document.createElement("div");
    noteBox=document.createElement("div");
    root.appendChild(style);
    root.appendChild(frameBox);
    root.appendChild(noteBox);
    document.body.appendChild(host);
  }
  function send(op){
    if(!port)return;
    port.postMessage({type:"ark:diagram-note-op",op:op,viewWidth:document.documentElement.clientWidth});
  }
  function textOf(element){
    return (element.innerText||"").replace(/\\u00a0/g," ").replace(/\\n+$/,"");
  }
  function flushText(id){
    if(timers[id]===undefined)return;
    clearTimeout(timers[id]);
    delete timers[id];
    var entry=elements[id];
    if(entry)send({type:"text",id:id,text:textOf(entry.text)});
  }
  function place(entry,x,y){
    entry.x=x;entry.y=y;
    entry.node.style.left=x+"px";
    entry.node.style.top=y+"px";
  }
  function create(note){
    var node=document.createElement("div");
    node.className="note"+(note.author==="claude"?" claude":"");
    var grip=document.createElement("div");
    grip.className="grip";
    var label=document.createElement("span");
    label.textContent=note.author==="claude"?"Claude":"";
    var close=document.createElement("button");
    close.className="close";
    close.type="button";
    close.textContent="\\u00d7";
    close.setAttribute("aria-label","Delete note");
    var text=document.createElement("div");
    text.className="text";
    text.textContent=note.text;
    grip.appendChild(label);
    grip.appendChild(close);
    node.appendChild(grip);
    node.appendChild(text);
    var entry={id:note.id,node:node,text:text,x:0,y:0};
    place(entry,note.x,note.y);
    if(note.author!=="claude"){
      text.setAttribute("contenteditable","plaintext-only");
      // Browsers without plaintext-only ignore the value and leave it not editable
      if(text.contentEditable!=="plaintext-only")text.setAttribute("contenteditable","true");
      text.spellcheck=false;
      text.addEventListener("input",function(){
        if(timers[note.id]!==undefined)clearTimeout(timers[note.id]);
        timers[note.id]=setTimeout(function(){flushText(note.id);},SEND_DELAY);
      });
      text.addEventListener("blur",function(){flushText(note.id);});
    }
    close.addEventListener("pointerdown",function(event){event.stopPropagation();});
    close.addEventListener("click",function(){
      remove(note.id);
      send({type:"delete",id:note.id});
    });
    grip.addEventListener("pointerdown",function(event){
      if(event.isPrimary===false||event.button>0)return;
      var origin=host.getBoundingClientRect();
      dragging={id:note.id,dx:event.clientX-origin.left-entry.x,dy:event.clientY-origin.top-entry.y,moved:false};
      grip.setPointerCapture(event.pointerId);
      node.classList.add("drag");
      event.preventDefault();
    });
    grip.addEventListener("pointermove",function(event){
      if(!dragging||dragging.id!==note.id)return;
      var origin=host.getBoundingClientRect();
      dragging.moved=true;
      place(entry,Math.max(0,Math.round(event.clientX-origin.left-dragging.dx)),Math.max(0,Math.round(event.clientY-origin.top-dragging.dy)));
    });
    function drop(){
      if(!dragging||dragging.id!==note.id)return;
      var moved=dragging.moved;
      dragging=null;
      node.classList.remove("drag");
      if(moved)send({type:"move",id:note.id,x:entry.x,y:entry.y});
    }
    grip.addEventListener("pointerup",drop);
    grip.addEventListener("pointercancel",drop);
    noteBox.appendChild(node);
    elements[note.id]=entry;
    return entry;
  }
  function remove(id){
    var entry=elements[id];
    if(!entry)return;
    if(timers[id]!==undefined){clearTimeout(timers[id]);delete timers[id];}
    if(entry.node.parentNode)entry.node.parentNode.removeChild(entry.node);
    delete elements[id];
  }
  function render(data){
    mount();
    var notes=Array.isArray(data.notes)?data.notes:[];
    var frames=Array.isArray(data.frames)?data.frames:[];
    frameBox.textContent="";
    frames.forEach(function(frame){
      var node=document.createElement("div");
      node.className="frame";
      node.style.left=frame.x+"px";
      node.style.top=frame.y+"px";
      node.style.width=frame.w+"px";
      node.style.height=frame.h+"px";
      var label=document.createElement("b");
      label.textContent=frame.label;
      node.appendChild(label);
      frameBox.appendChild(node);
    });
    var seen={};
    notes.forEach(function(note){
      seen[note.id]=true;
      var entry=elements[note.id];
      if(!entry){create(note);return;}
      // Keep what the user is holding: the position while dragging, the text while typing
      if(!dragging||dragging.id!==note.id)place(entry,note.x,note.y);
      var typing=root.activeElement===entry.text||timers[note.id]!==undefined;
      if(!typing&&entry.text.textContent!==note.text)entry.text.textContent=note.text;
    });
    Object.keys(elements).forEach(function(id){
      if(seen[id])return;
      // A note the user just added may not have reached the file yet
      if(elements[id].pending){return;}
      if(dragging&&dragging.id===id)dragging=null;
      remove(id);
    });
    notes.forEach(function(note){if(elements[note.id])elements[note.id].pending=false;});
  }
  function add(){
    mount();
    var origin=host.getBoundingClientRect();
    var x=Math.max(0,Math.round(document.documentElement.clientWidth/2-origin.left-W/2));
    var y=Math.max(0,Math.round(window.innerHeight/2-origin.top-H/2));
    // Do not drop a new note exactly on top of another one
    var taken=true;
    while(taken){
      taken=false;
      for(var key in elements){
        if(Math.abs(elements[key].x-x)<12&&Math.abs(elements[key].y-y)<12){taken=true;x+=24;y+=24;break;}
      }
    }
    var id="h"+Date.now().toString(36)+Math.random().toString(36).slice(2,8);
    var entry=create({id:id,author:"human",text:"",x:x,y:y});
    entry.pending=true;
    send({type:"add",id:id,x:x,y:y});
    try{window.focus();}catch(error){}
    entry.text.focus();
  }
  window.addEventListener("message",function(event){
    if(port||!event.data||event.data.type!=="ark:diagram-init"||!event.ports||!event.ports[0])return;
    port=event.ports[0];
    port.addEventListener("message",function(message){
      var data=message.data;
      if(!data)return;
      if(data.type==="ark:diagram-notes")render(data);
      else if(data.type==="ark:diagram-note-add")add();
      // The server refused to save a note the user just added. Take it off the board
      else if(data.type==="ark:diagram-note-drop"&&typeof data.id==="string"&&elements[data.id]&&elements[data.id].pending)remove(data.id);
    });
    port.start();
  });
  // Typed text that has not been sent yet would be lost when the document is replaced
  window.addEventListener("pagehide",function(){Object.keys(timers).forEach(flushText);});
})();
</script>`;

const scriptContentStart = NOTES_LAYER.indexOf(">") + 1;
const scriptContentEnd = NOTES_LAYER.lastIndexOf("</script>");
const minifyNotesLayerJavaScript = createCachedMinifier(
  NOTES_LAYER.slice(scriptContentStart, scriptContentEnd),
  "js"
);

let minifiedNotesLayer: string | undefined;

function getMinifiedNotesLayer(): string {
  if (minifiedNotesLayer === undefined) {
    minifiedNotesLayer = `${NOTES_LAYER.slice(0, scriptContentStart)}${minifyNotesLayerJavaScript()}${NOTES_LAYER.slice(scriptContentEnd)}`;
  }
  return minifiedNotesLayer;
}

// 本文に marker の語が書かれているだけの板で注入が止まらないよう、実際に注入した
// <script id="..."> の有無で見る (リンク層と同じ)
const INJECTED_SCRIPT_RE = new RegExp(
  `<script[^>]*\\bid=["']${DIAGRAM_NOTES_LAYER_MARKER}["']`,
  "i"
);

/** </body> 直前へ 1 回だけ注入する。注入済みならそのまま返す。 */
export function injectDiagramNotesLayer(html: string): string {
  if (INJECTED_SCRIPT_RE.test(html)) return html;
  const layer = getMinifiedNotesLayer();
  const bodyClose = html.toLowerCase().lastIndexOf("</body>");
  if (bodyClose < 0) return `${html}${layer}`;
  return `${html.slice(0, bodyClose)}${layer}${html.slice(bodyClose)}`;
}
