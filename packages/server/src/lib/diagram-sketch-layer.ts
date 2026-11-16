import { createCachedMinifier } from "./injected-minify.js";

export const DIAGRAM_SKETCH_LAYER_MARKER = "ark-diagram-sketch-layer";

/**
 * ボードの図の上に手で描き、描いたあたりを図ごと1枚の画像にして親へ渡す層。
 *
 * 文字では渡しにくいもの (囲み、矢印、画面のラフ) を、Apple Pencil やマウスで図の上に
 * 直接描いて Claude に見せるためのもの。親は受け取った画像を会話の入力欄に添付する
 * (DiagramPane.tsx)。送信は人が押す。
 *
 * - 右下の「描く」を押している間だけ描ける。描くのはペンとマウスで、指はスクロールに使う。
 *   ペンと指をブラウザに任せて分けることはできないので、描いている間は touch-action を
 *   none にし、指の動きはこの層が自分でスクロールへ変える (2本指はピンチの層に任せる)
 * - 線は文書の座標で覚え、画面と同じ大きさの canvas へ、スクロールのたびに描き直す
 *   (長い図でも canvas を大きくしない)
 * - 画像は図の中で作る。文書の写しを SVG の foreignObject に入れて canvas に描き、
 *   その上に線を重ねる。親は sandbox の iframe の見た目を画像にできない
 * - 写しは今の図と同じ幅で組む (横にはみ出す図でも、中央寄せや折り返しの位置を変えない)
 * - 画像にするのは線を囲む範囲と余白だけ (線が無ければ見えている範囲)。図の全体を
 *   1枚にすると、長い図では文字が読めない大きさに縮む
 * - 線はファイルに残さない。図が読み直されると消える
 *
 * 部品は Shadow DOM の中に置き、図の CSS の影響を受けないようにする。
 * port の扱いはリンク層 (diagram-link-layer.ts) と同じ。
 */
export const SKETCH_LAYER = `<script id="${DIAGRAM_SKETCH_LAYER_MARKER}">
(function(){
  "use strict";
  var port=null;
  var MARGIN=140;
  var MAX_EDGE=2000;
  var INK="#e11d48";
  var labels={draw:"Draw",undo:"Undo",clear:"Clear",send:"Show Claude",sending:"Sending...",close:"Done"};
  var strokes=[];
  var current=null;
  var drawing=false;
  var sending=false;
  var touches={};
  var host=document.createElement("ark-sketch");
  host.setAttribute("style","all:initial!important;position:fixed!important;inset:0!important;z-index:2147483646!important;pointer-events:none!important;display:block!important;");
  var root=host.attachShadow({mode:"open"});
  var canvas=document.createElement("canvas");
  canvas.setAttribute("style","position:fixed;inset:0;width:100%;height:100%;pointer-events:none;touch-action:none;");
  var bar=document.createElement("div");
  bar.setAttribute("style","position:fixed;right:12px;bottom:12px;display:flex;gap:6px;pointer-events:auto;font:600 13px/1 system-ui,sans-serif;");
  root.appendChild(canvas);
  root.appendChild(bar);
  var ctx=canvas.getContext("2d");
  function ratio(){return Math.min(window.devicePixelRatio||1,2);}
  function button(key,primary,onPress){
    var el=document.createElement("button");
    el.type="button";
    el.setAttribute("data-key",key);
    el.setAttribute("style","all:initial;font:inherit;cursor:pointer;padding:9px 12px;border-radius:999px;box-shadow:0 1px 4px rgba(0,0,0,.25);border:1px solid "+(primary?INK:"#d4d4d8")+";background:"+(primary?INK:"#fff")+";color:"+(primary?"#fff":"#27272a")+";");
    el.addEventListener("click",function(event){event.preventDefault();event.stopPropagation();onPress();});
    return el;
  }
  var buttons={
    draw:button("draw",false,function(){setDrawing(true);}),
    undo:button("undo",false,function(){strokes.pop();paint();sync();}),
    clear:button("clear",false,function(){strokes=[];paint();sync();}),
    send:button("send",true,send),
    close:button("close",false,function(){setDrawing(false);})
  };
  function sync(){
    bar.textContent="";
    var keys=drawing?["undo","clear","send","close"]:["draw"];
    keys.forEach(function(key){
      var el=buttons[key];
      el.textContent=key==="send"&&sending?labels.sending:labels[key];
      var off=(key==="undo"||key==="clear"||key==="send")&&(strokes.length===0||sending);
      el.disabled=off;
      el.style.opacity=off?"0.45":"1";
      bar.appendChild(el);
    });
  }
  function setDrawing(on){
    drawing=on;
    current=null;
    canvas.style.pointerEvents=on?"auto":"none";
    canvas.style.cursor=on?"crosshair":"";
    sync();
  }
  function fit(){
    var r=ratio();
    canvas.width=Math.round(window.innerWidth*r);
    canvas.height=Math.round(window.innerHeight*r);
    paint();
  }
  // Strokes are kept in document coordinates. (ox, oy) is the document point drawn at the canvas origin
  function drawStrokes(target,scale,ox,oy){
    target.lineCap="round";
    target.lineJoin="round";
    target.strokeStyle=INK;
    target.fillStyle=INK;
    for(var s=0;s<strokes.length;s++){
      var stroke=strokes[s];
      if(stroke.length===1){
        target.beginPath();
        target.arc((stroke[0].x-ox)*scale,(stroke[0].y-oy)*scale,stroke[0].w*scale/2,0,Math.PI*2);
        target.fill();
        continue;
      }
      for(var i=1;i<stroke.length;i++){
        target.beginPath();
        target.lineWidth=stroke[i].w*scale;
        target.moveTo((stroke[i-1].x-ox)*scale,(stroke[i-1].y-oy)*scale);
        target.lineTo((stroke[i].x-ox)*scale,(stroke[i].y-oy)*scale);
        target.stroke();
      }
    }
  }
  function paint(){
    ctx.clearRect(0,0,canvas.width,canvas.height);
    drawStrokes(ctx,ratio(),window.scrollX,window.scrollY);
  }
  function pointOf(event){
    var pressure=event.pointerType==="pen"&&event.pressure>0?event.pressure:0.5;
    return {x:event.clientX+window.scrollX,y:event.clientY+window.scrollY,w:1.5+3.5*pressure};
  }
  function countTouches(){return Object.keys(touches).length;}
  canvas.addEventListener("pointerdown",function(event){
    if(!drawing)return;
    if(event.pointerType==="touch"){
      touches[event.pointerId]={x:event.clientX,y:event.clientY};
      return;
    }
    // A stroke added while the picture is on its way would be cleared without being in it
    if(event.button!==0||sending)return;
    event.preventDefault();
    try{canvas.setPointerCapture(event.pointerId);}catch(e){}
    current=[pointOf(event)];
    strokes.push(current);
    paint();
    sync();
  });
  canvas.addEventListener("pointermove",function(event){
    if(!drawing)return;
    if(event.pointerType==="touch"){
      var last=touches[event.pointerId];
      if(!last)return;
      // One finger scrolls the board. Two fingers are a pinch, which the pinch layer handles
      if(countTouches()===1)window.scrollBy(last.x-event.clientX,last.y-event.clientY);
      touches[event.pointerId]={x:event.clientX,y:event.clientY};
      return;
    }
    if(!current)return;
    event.preventDefault();
    var events=event.getCoalescedEvents?event.getCoalescedEvents():[];
    if(!events.length)events=[event];
    for(var i=0;i<events.length;i++)current.push(pointOf(events[i]));
    paint();
  });
  function release(event){
    if(event.pointerType==="touch"){delete touches[event.pointerId];return;}
    current=null;
  }
  canvas.addEventListener("pointerup",release);
  canvas.addEventListener("pointercancel",release);
  window.addEventListener("scroll",paint,{passive:true});
  window.addEventListener("resize",fit);

  function cropRect(docWidth,docHeight){
    var left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity;
    for(var s=0;s<strokes.length;s++)for(var i=0;i<strokes[s].length;i++){
      var p=strokes[s][i];
      if(p.x<left)left=p.x;
      if(p.y<top)top=p.y;
      if(p.x>right)right=p.x;
      if(p.y>bottom)bottom=p.y;
    }
    if(left===Infinity){left=window.scrollX;top=window.scrollY;right=left+window.innerWidth;bottom=top+window.innerHeight;}
    else{left-=MARGIN;top-=MARGIN;right+=MARGIN;bottom+=MARGIN;}
    left=Math.max(0,Math.floor(left));
    top=Math.max(0,Math.floor(top));
    right=Math.min(docWidth,Math.ceil(right));
    bottom=Math.min(docHeight,Math.ceil(bottom));
    return {x:left,y:top,w:Math.max(1,right-left),h:Math.max(1,bottom-top)};
  }
  function fail(){
    sending=false;
    sync();
    if(port)port.postMessage({type:"ark:diagram-sketch-error"});
  }
  function send(){
    if(!port||sending||strokes.length===0)return;
    sending=true;
    sync();
    try{
      var page=document.documentElement;
      var docWidth=Math.ceil(Math.max(page.scrollWidth,window.innerWidth));
      var docHeight=Math.ceil(Math.max(page.scrollHeight,window.innerHeight));
      // Lay the copy out at the width the board is laid out at now. A wider box would move
      // centred or wrapped content away from the strokes. What overflows it is still painted
      var layoutWidth=Math.max(1,page.clientWidth||window.innerWidth);
      var originals=page.querySelectorAll("canvas");
      var clone=page.cloneNode(true);
      // A cloned <canvas> is blank, so carry its pixels over as an image
      var copies=clone.querySelectorAll("canvas");
      for(var i=0;i<originals.length;i++){
        try{
          var picture=document.createElement("img");
          picture.setAttribute("src",originals[i].toDataURL());
          picture.setAttribute("style",originals[i].getAttribute("style")||"");
          picture.setAttribute("class",originals[i].getAttribute("class")||"");
          picture.setAttribute("width",String(originals[i].clientWidth));
          picture.setAttribute("height",String(originals[i].clientHeight));
          copies[i].parentNode.replaceChild(picture,copies[i]);
        }catch(e){}
      }
      var drop=clone.querySelectorAll("script,ark-sketch,meta[http-equiv]");
      for(var d=0;d<drop.length;d++)if(drop[d].parentNode)drop[d].parentNode.removeChild(drop[d]);
      var xhtml=new XMLSerializer().serializeToString(clone);
      var svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+docWidth+'" height="'+docHeight+'"><foreignObject x="0" y="0" width="'+layoutWidth+'" height="'+docHeight+'" style="overflow:visible">'+xhtml+"</foreignObject></svg>";
      var crop=cropRect(docWidth,docHeight);
      var scale=Math.min(2,MAX_EDGE/Math.max(crop.w,crop.h));
      var image=new Image();
      image.onerror=fail;
      image.onload=function(){
        try{
          var out=document.createElement("canvas");
          out.width=Math.round(crop.w*scale);
          out.height=Math.round(crop.h*scale);
          var c=out.getContext("2d");
          c.fillStyle="#fff";
          c.fillRect(0,0,out.width,out.height);
          c.drawImage(image,-crop.x*scale,-crop.y*scale,docWidth*scale,docHeight*scale);
          drawStrokes(c,scale,crop.x,crop.y);
          port.postMessage({type:"ark:diagram-sketch",dataUrl:out.toDataURL("image/png")});
        }catch(e){fail();}
      };
      image.src="data:image/svg+xml;charset=utf-8,"+encodeURIComponent(svg);
    }catch(e){fail();}
  }
  function start(){
    if(host.isConnected)return;
    (document.body||document.documentElement).appendChild(host);
    fit();
    sync();
  }
  window.addEventListener("message",function(event){
    if(port||!event.data||event.data.type!=="ark:diagram-init"||!event.ports||!event.ports[0])return;
    port=event.ports[0];
    port.addEventListener("message",function(message){
      var data=message.data;
      if(!data)return;
      if(data.type==="ark:diagram-sketch-labels"&&data.labels){
        for(var key in labels)if(typeof data.labels[key]==="string")labels[key]=data.labels[key];
        sync();
      }else if(data.type==="ark:diagram-sketch-result"){
        // The parent attached the picture to the chat input: the strokes have done their job
        sending=false;
        if(data.ok){strokes=[];paint();setDrawing(false);}
        else sync();
      }
    });
    port.start();
    // Without a parent to hand the picture to, the controls would do nothing
    start();
  });
})();
</script>`;

const scriptContentStart = SKETCH_LAYER.indexOf(">") + 1;
const scriptContentEnd = SKETCH_LAYER.lastIndexOf("</script>");
const minifySketchLayerJavaScript = createCachedMinifier(
  SKETCH_LAYER.slice(scriptContentStart, scriptContentEnd),
  "js"
);

let minifiedSketchLayer: string | undefined;

function getMinifiedSketchLayer(): string {
  if (minifiedSketchLayer === undefined) {
    minifiedSketchLayer = `${SKETCH_LAYER.slice(0, scriptContentStart)}${minifySketchLayerJavaScript()}${SKETCH_LAYER.slice(scriptContentEnd)}`;
  }
  return minifiedSketchLayer;
}

// 本文に marker の語が書かれているだけの板で注入が止まらないよう、実際に注入した
// <script id="..."> の有無で見る (リンク層と同じ)
const INJECTED_SCRIPT_RE = new RegExp(
  `<script[^>]*\\bid=["']${DIAGRAM_SKETCH_LAYER_MARKER}["']`,
  "i"
);

/** </body> 直前へ 1 回だけ注入する。注入済みならそのまま返す。 */
export function injectDiagramSketchLayer(html: string): string {
  if (INJECTED_SCRIPT_RE.test(html)) return html;
  const layer = getMinifiedSketchLayer();
  const bodyClose = html.toLowerCase().lastIndexOf("</body>");
  if (bodyClose < 0) return `${html}${layer}`;
  return `${html.slice(0, bodyClose)}${layer}${html.slice(bodyClose)}`;
}
