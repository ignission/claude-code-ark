import { DIAGRAM_SELECTION_TEXT_LIMIT } from "@ark/shared";
import { createCachedMinifier } from "./injected-minify.js";

export const DIAGRAM_SELECT_LAYER_MARKER = "ark-diagram-select-layer";

/**
 * ボードの一部を四角で囲み、その中に見えている文字を親へ渡す層。
 *
 * 親はこの文字を会話の入力欄へ引用として入れるだけで、あとは普段のメッセージとして
 * 送る (DiagramPane.tsx)。ボードの側にはコメントもスレッドも保存しない。以前の図解コメントは、
 * 選ぶ、書く、送る、返信を読む、解決にする、と手数が多く、チャットに書くほうが早かった。
 *
 * 図の中身は解釈しない。囲んだ四角と重なる文字を、見えているまま写すだけにする
 * (要素の種類や構造には意味を持たせない)。折り返した文は、四角が触れた行だけを写す。
 * 文字の無い絵だけを囲んだときは空の文字列を送る。
 *
 * 範囲選択は親が `ark:diagram-select` で始めさせる。普段はドラッグが本文の選択と
 * スクロールに使われるので、始めている間だけ全面に透明な膜を置いてドラッグを受ける。
 *
 * port の扱いはリンク層 (diagram-link-layer.ts) と同じ。
 */
export const SELECT_LAYER = `<script id="${DIAGRAM_SELECT_LAYER_MARKER}">
(function(){
  "use strict";
  var LIMIT=${DIAGRAM_SELECTION_TEXT_LIMIT};
  var MIN_SIZE=4;
  var port=null;
  var veil=null;
  var box=null;
  var origin=null;
  function rectBetween(a,b){
    return {left:Math.min(a.x,b.x),top:Math.min(a.y,b.y),right:Math.max(a.x,b.x),bottom:Math.max(a.y,b.y)};
  }
  function overlaps(a,b){
    return a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top;
  }
  // The nearest ancestor that is not laid out inline. Text nodes that share it
  // are read as one line, so inline markup does not split a sentence
  function blockOf(element){
    var current=element;
    while(current&&current!==document.body){
      var display=window.getComputedStyle(current).display;
      if(display.indexOf("inline")!==0&&display!=="contents")return current;
      current=current.parentElement;
    }
    return document.body;
  }
  function visible(element){
    if(typeof element.checkVisibility==="function")return element.checkVisibility({opacityProperty:true,visibilityProperty:true});
    return window.getComputedStyle(element).visibility!=="hidden";
  }
  // The part of a text node that lies on the lines the box touches. A node that
  // wraps has one rect per line, so a box over one line does not quote the others
  function partOf(node,range,selection){
    range.selectNodeContents(node);
    var rects=range.getClientRects();
    var hits=[];
    var shown=0;
    for(var i=0;i<rects.length;i++){
      if(rects[i].width<=0||rects[i].height<=0)continue;
      shown++;
      if(overlaps(rects[i],selection))hits.push(rects[i]);
    }
    var value=node.nodeValue;
    if(hits.length===0)return "";
    if(hits.length===shown)return value;
    var part="";
    var keep=false;
    for(var c=0;c<value.length;c++){
      range.setStart(node,c);
      range.setEnd(node,c+1);
      var rect=range.getBoundingClientRect();
      // A character without a box (a space at a line break) follows the one before it
      if(rect.width>0&&rect.height>0){
        var x=(rect.left+rect.right)/2;
        var y=(rect.top+rect.bottom)/2;
        keep=false;
        for(var h=0;h<hits.length;h++){
          if(x>=hits[h].left&&x<=hits[h].right&&y>=hits[h].top&&y<=hits[h].bottom){keep=true;break;}
        }
      }
      if(keep)part+=value.charAt(c);
    }
    return part;
  }
  function collect(selection){
    var walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT,null);
    var range=document.createRange();
    var lines=[];
    var lastBlock=null;
    var pendingSpace=false;
    var node;
    while((node=walker.nextNode())){
      var value=node.nodeValue;
      if(!value)continue;
      var parent=node.parentElement;
      if(!parent||parent.closest("script,style,noscript,template,[data-ark-layer]"))continue;
      if(!/\\S/.test(value)){
        // Whitespace between inline elements shows as a space. Keep it when the
        // text on both sides of it is quoted
        if(lines.length>0&&blockOf(parent)===lastBlock)pendingSpace=true;
        continue;
      }
      if(!visible(parent))continue;
      var part=partOf(node,range,selection);
      if(!part)continue;
      var block=blockOf(parent);
      if(block===lastBlock&&lines.length>0)lines[lines.length-1]+=(pendingSpace?" ":"")+part;
      else lines.push(part);
      lastBlock=block;
      pendingSpace=false;
    }
    var text=lines.map(function(line){return line.replace(/\\s+/g," ").trim();}).filter(Boolean).join("\\n");
    if(text.length<=LIMIT)return {text:text,truncated:false};
    return {text:text.slice(0,LIMIT),truncated:true};
  }
  function stop(){
    origin=null;
    if(veil&&veil.parentNode)veil.parentNode.removeChild(veil);
    veil=null;
    box=null;
  }
  function drawBox(rect){
    box.style.left=rect.left+"px";
    box.style.top=rect.top+"px";
    box.style.width=(rect.right-rect.left)+"px";
    box.style.height=(rect.bottom-rect.top)+"px";
    box.style.display="block";
  }
  function start(){
    if(veil)return;
    veil=document.createElement("div");
    veil.setAttribute("data-ark-layer","select");
    veil.style.cssText="position:fixed;inset:0;z-index:2147483647;cursor:crosshair;touch-action:none;background:transparent;user-select:none;-webkit-user-select:none;";
    box=document.createElement("div");
    box.style.cssText="position:absolute;display:none;box-sizing:border-box;border:2px dashed #2563eb;background:rgba(37,99,235,.12);pointer-events:none;";
    veil.appendChild(box);
    veil.addEventListener("pointerdown",function(event){
      if(event.isPrimary===false)return;
      origin={x:event.clientX,y:event.clientY};
      if(veil.setPointerCapture)veil.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    veil.addEventListener("pointermove",function(event){
      if(!origin)return;
      drawBox(rectBetween(origin,{x:event.clientX,y:event.clientY}));
    });
    veil.addEventListener("pointerup",function(event){
      if(!origin)return;
      var rect=rectBetween(origin,{x:event.clientX,y:event.clientY});
      origin=null;
      // A press without a drag is not a selection. Keep waiting for a drag
      if(rect.right-rect.left<MIN_SIZE||rect.bottom-rect.top<MIN_SIZE){box.style.display="none";return;}
      var result=collect(rect);
      stop();
      if(port)port.postMessage({type:"ark:diagram-selection",text:result.text,truncated:result.truncated});
    });
    veil.addEventListener("pointercancel",function(){origin=null;if(box)box.style.display="none";});
    document.body.appendChild(veil);
  }
  window.addEventListener("keydown",function(event){
    if(!veil||event.key!=="Escape")return;
    stop();
    if(port)port.postMessage({type:"ark:diagram-select-cancel"});
  });
  window.addEventListener("message",function(event){
    if(port||!event.data||event.data.type!=="ark:diagram-init"||!event.ports||!event.ports[0])return;
    port=event.ports[0];
    port.addEventListener("message",function(message){
      var data=message.data;
      if(!data||data.type!=="ark:diagram-select")return;
      if(data.active)start();else stop();
    });
    port.start();
  });
})();
</script>`;

const scriptContentStart = SELECT_LAYER.indexOf(">") + 1;
const scriptContentEnd = SELECT_LAYER.lastIndexOf("</script>");
const minifySelectLayerJavaScript = createCachedMinifier(
  SELECT_LAYER.slice(scriptContentStart, scriptContentEnd),
  "js"
);

let minifiedSelectLayer: string | undefined;

function getMinifiedSelectLayer(): string {
  if (minifiedSelectLayer === undefined) {
    minifiedSelectLayer = `${SELECT_LAYER.slice(0, scriptContentStart)}${minifySelectLayerJavaScript()}${SELECT_LAYER.slice(scriptContentEnd)}`;
  }
  return minifiedSelectLayer;
}

// 本文に marker の語が書かれているだけの板で注入が止まらないよう、実際に注入した
// <script id="..."> の有無で見る (リンク層と同じ)
const INJECTED_SCRIPT_RE = new RegExp(
  `<script[^>]*\\bid=["']${DIAGRAM_SELECT_LAYER_MARKER}["']`,
  "i"
);

/** </body> 直前へ 1 回だけ注入する。注入済みならそのまま返す。 */
export function injectDiagramSelectLayer(html: string): string {
  if (INJECTED_SCRIPT_RE.test(html)) return html;
  const layer = getMinifiedSelectLayer();
  const bodyClose = html.toLowerCase().lastIndexOf("</body>");
  if (bodyClose < 0) return `${html}${layer}`;
  return `${html.slice(0, bodyClose)}${layer}${html.slice(bodyClose)}`;
}
