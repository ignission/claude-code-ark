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
 * - 消しゴムは、触れた線を1本まるごと消す。「戻す」は線を足す・消すの1手ずつを戻す
 * - 線は文書の座標で覚え、画面と同じ大きさの canvas へ、スクロールのたびに描き直す
 *   (長い図でも canvas を大きくしない)
 * - 画像は図の中で作る。文書の写しを SVG の foreignObject に入れて canvas に描き、
 *   その上に線を重ねる。親は sandbox の iframe の見た目を画像にできない
 * - 写しの中の `<img>` を描かないエンジンがある (WebKit)。その場合は、図の中の画像と
 *   canvas を、ページ上の位置に合わせて上から描き足す (重なりの順は再現しない)
 * - 写しは今の図と同じ幅で組む (横にはみ出す図でも、中央寄せや折り返しの位置を変えない)
 * - 画像にするのは、見えている範囲を、線がすべて入るまで広げた範囲。図の全体を1枚に
 *   すると、長い図では文字が読めない大きさに縮む。線が無くても見せられる (触れる図に
 *   人が書き込んだ内容など、図そのものを見せたいことがある)
 * - 線はファイルに残さない。線と「描いている最中か」を親が覚えておき、図が読み直されたら
 *   返してもらう (描いている途中で Claude が図を書き換えても、線も描くモードも失わない)
 * - Apple Pencil はタッチとしても届く。手のひらを置いて書くと2点のタッチになり、ピンチの層が
 *   拡大縮小と読む。描いている間は、ペンを含むタッチをピンチの層へ渡さない。手のひらの
 *   動きでスクロールもしない
 *
 * - 親のツールバーの「画像としてコピー」も、この層が画像を作る。こちらは図の全体を1枚にし
 *   (漫画のように全体で読む図のため)、大きさは面積で抑える (iOS は大きすぎる canvas を作らない)。
 *   書き込むのは親で、sandbox の iframe はクリップボードに書けない
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
  // Copying takes the whole board, so it is capped by area (iOS refuses larger canvases)
  var MAX_COPY_PIXELS=16000000;
  var MAX_COPY_EDGE=16000;
  var MAX_DRAWS=6;
  var REDRAW_WAIT=90;
  var INK="#e11d48";
  var ERASE_RADIUS=12;
  var MAX_HISTORY=50;
  var labels={draw:"Draw",eraser:"Eraser",undo:"Undo",clear:"Clear all",send:"Show Claude",sending:"Sending...",close:"Done"};
  var strokes=[];
  // Earlier states of strokes, for "Undo". A finished stroke is never changed, so each
  // state is a shallow copy of the list
  var history=[];
  var current=null;
  var erasing=false;
  var rubbing=false;
  var rubbed=false;
  var drawing=false;
  var sending=false;
  var copying=false;
  var touches={};
  var host=document.createElement("ark-sketch");
  host.setAttribute("style","all:initial!important;position:fixed!important;inset:0!important;z-index:2147483646!important;pointer-events:none!important;display:block!important;");
  var root=host.attachShadow({mode:"open"});
  var canvas=document.createElement("canvas");
  canvas.setAttribute("style","position:fixed;inset:0;width:100%;height:100%;pointer-events:none;touch-action:none;");
  var bar=document.createElement("div");
  bar.setAttribute("style","position:fixed;right:12px;bottom:12px;max-width:calc(100% - 24px);display:flex;flex-wrap:wrap;justify-content:flex-end;gap:6px;pointer-events:auto;font:600 13px/1 system-ui,sans-serif;");
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
    eraser:button("eraser",false,function(){erasing=!erasing;current=null;sync();}),
    undo:button("undo",false,function(){if(history.length){strokes=history.pop();paint();sync();changed();}}),
    clear:button("clear",false,function(){remember();strokes=[];paint();sync();changed();}),
    send:button("send",true,send),
    close:button("close",false,function(){setDrawing(false);})
  };
  // The parent keeps the strokes, and hands them back when the board is reloaded
  // (Claude rewriting the board must not wipe a drawing in progress)
  function remember(){
    history.push(strokes.slice());
    if(history.length>MAX_HISTORY)history.shift();
  }
  function distance(px,py,a,b){
    var dx=b.x-a.x,dy=b.y-a.y;
    var len=dx*dx+dy*dy;
    var t=len?Math.max(0,Math.min(1,((px-a.x)*dx+(py-a.y)*dy)/len)):0;
    return Math.hypot(px-(a.x+t*dx),py-(a.y+t*dy));
  }
  // The eraser takes away whole strokes: every stroke it touches
  function eraseAt(x,y){
    var kept=[];
    for(var s=0;s<strokes.length;s++){
      var stroke=strokes[s],hit=false;
      for(var i=0;i<stroke.length&&!hit;i++){
        hit=distance(x,y,stroke[i>0?i-1:0],stroke[i])<=ERASE_RADIUS+stroke[i].w/2;
      }
      if(!hit)kept.push(stroke);
    }
    if(kept.length===strokes.length)return;
    if(!rubbed){remember();rubbed=true;}
    strokes=kept;
    paint();
  }
  function changed(){
    if(port)port.postMessage({type:"ark:diagram-sketch-strokes",strokes:strokes,drawing:drawing});
  }
  function sync(){
    bar.textContent="";
    // With nothing left to erase, go back to the pen
    if(strokes.length===0)erasing=false;
    canvas.style.cursor=drawing?(erasing?"cell":"crosshair"):"";
    var keys=drawing?["eraser","undo","clear","send","close"]:["draw"];
    keys.forEach(function(key){
      var el=buttons[key];
      el.textContent=key==="send"&&sending?labels.sending:labels[key];
      // "Show Claude" works without strokes too: the board itself may hold what the user
      // wants to show (something typed or drawn in an interactive board)
      var off=key==="send"?sending:key==="undo"?history.length===0||sending:(key==="clear"||key==="eraser")&&(strokes.length===0||sending);
      el.disabled=off;
      el.style.opacity=off?"0.45":"1";
      if(key==="eraser"){
        el.style.background=erasing?"#27272a":"#fff";
        el.style.color=erasing?"#fff":"#27272a";
        el.setAttribute("aria-pressed",erasing?"true":"false");
      }
      bar.appendChild(el);
    });
  }
  function setDrawing(on){
    drawing=on;
    current=null;
    erasing=false;
    canvas.style.pointerEvents=on?"auto":"none";
    sync();
    // The parent keeps the mode too: a reloaded board must not drop out of drawing
    changed();
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
    return {x:Math.round((event.clientX+window.scrollX)*10)/10,y:Math.round((event.clientY+window.scrollY)*10)/10,w:Math.round((1.5+3.5*pressure)*10)/10};
  }
  function countTouches(){return Object.keys(touches).length;}
  canvas.addEventListener("pointerdown",function(event){
    if(!drawing)return;
    if(event.pointerType==="touch"){
      touches[event.pointerId]={x:event.clientX,y:event.clientY};
      return;
    }
    // A stroke added while the picture is on its way would be cleared without being in it
    if((event.button!==0&&event.button!==5)||sending)return;
    event.preventDefault();
    try{canvas.setPointerCapture(event.pointerId);}catch(e){}
    // The eraser end of a pen reports button 5 (bit 32), where the pen has one
    if(erasing||(event.buttons&32)){
      rubbing=true;
      rubbed=false;
      eraseAt(event.clientX+window.scrollX,event.clientY+window.scrollY);
      return;
    }
    remember();
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
      // A palm resting on the screen moves a little while the pen writes: no scrolling then
      if(countTouches()===1&&!current&&!rubbing)window.scrollBy(last.x-event.clientX,last.y-event.clientY);
      touches[event.pointerId]={x:event.clientX,y:event.clientY};
      return;
    }
    if(!current&&!rubbing)return;
    event.preventDefault();
    var events=event.getCoalescedEvents?event.getCoalescedEvents():[];
    if(!events.length)events=[event];
    for(var i=0;i<events.length;i++){
      if(rubbing)eraseAt(events[i].clientX+window.scrollX,events[i].clientY+window.scrollY);
      else current.push(pointOf(events[i]));
    }
    if(!rubbing)paint();
  });
  function release(event){
    if(event.pointerType==="touch"){delete touches[event.pointerId];return;}
    if(current||rubbed)changed();
    current=null;
    if(rubbing){rubbing=false;rubbed=false;sync();}
  }
  canvas.addEventListener("pointerup",release);
  canvas.addEventListener("pointercancel",release);
  // Where the pen is a touch too (Apple Pencil), pen + resting palm arrive as two touches,
  // which the pinch layer would read as a pinch and zoom the board. While drawing, touches
  // that include the pen stop here, before the pinch layer's listeners on window
  function guardPen(event){
    if(!drawing)return;
    var list=event.touches||[];
    for(var i=0;i<list.length;i++){
      if(list[i].touchType==="stylus"){
        event.stopImmediatePropagation();
        return;
      }
    }
  }
  window.addEventListener("touchstart",guardPen,true);
  window.addEventListener("touchmove",guardPen,true);
  window.addEventListener("scroll",paint,{passive:true});
  window.addEventListener("resize",fit);

  // What goes into the picture: the part of the board on screen, widened to hold every stroke.
  // The screen is included so that what the user is looking at (and anything they wrote in the
  // board before drawing) is never cut off
  function cropRect(docWidth,docHeight){
    var left=window.scrollX,top=window.scrollY,right=left+window.innerWidth,bottom=top+window.innerHeight;
    for(var s=0;s<strokes.length;s++)for(var i=0;i<strokes[s].length;i++){
      var p=strokes[s][i];
      if(p.x-MARGIN<left)left=p.x-MARGIN;
      if(p.y-MARGIN<top)top=p.y-MARGIN;
      if(p.x+MARGIN>right)right=p.x+MARGIN;
      if(p.y+MARGIN>bottom)bottom=p.y+MARGIN;
    }
    left=Math.max(0,Math.floor(left));
    top=Math.max(0,Math.floor(top));
    right=Math.min(docWidth,Math.ceil(right));
    bottom=Math.min(docHeight,Math.ceil(bottom));
    return {x:left,y:top,w:Math.max(1,right-left),h:Math.max(1,bottom-top)};
  }
  // Some engines (WebKit) do not paint <img> inside the foreignObject of an SVG used as an image.
  // Find out once with a red pixel; where it is missing, images and canvases are drawn over the
  // picture at their place on the page instead
  var paintsImages=null;
  function probeImages(done){
    if(paintsImages!==null){done();return;}
    var probe=new Image();
    probe.onerror=function(){paintsImages=false;done();};
    probe.onload=function(){
      try{
        var k=document.createElement("canvas");
        k.width=4;k.height=4;
        var g=k.getContext("2d");
        g.drawImage(probe,0,0);
        var d=g.getImageData(1,1,1,1).data;
        paintsImages=d[0]>200&&d[1]<60&&d[3]>200;
      }catch(e){paintsImages=false;}
      done();
    };
    probe.src="data:image/svg+xml;charset=utf-8,"+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><foreignObject width="4" height="4"><img xmlns="http://www.w3.org/1999/xhtml" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC" width="4" height="4" style="display:block"/></foreignObject></svg>');
  }
  function drawPictures(c,scale,crop){
    var list=document.querySelectorAll("img,canvas");
    for(var i=0;i<list.length;i++){
      var rect=list[i].getBoundingClientRect();
      if(rect.width<1||rect.height<1)continue;
      if(window.getComputedStyle(list[i]).visibility==="hidden")continue;
      try{
        c.drawImage(list[i],(rect.left+window.scrollX-crop.x)*scale,(rect.top+window.scrollY-crop.y)*scale,rect.width*scale,rect.height*scale);
      }catch(e){}
    }
  }
  function fail(){
    sending=false;
    sync();
    if(port)port.postMessage({type:"ark:diagram-sketch-error"});
  }
  function send(){
    if(!port||sending||copying)return;
    sending=true;
    // End a stroke still being drawn (the button can be pressed with another finger):
    // what is added after the picture is taken would be cleared without being in it
    if(current||rubbed)changed();
    current=null;
    rubbing=false;
    rubbed=false;
    sync();
    probeImages(function(){
      capture(cropRect,function(crop){return Math.min(2,MAX_EDGE/Math.max(crop.w,crop.h));},function(dataUrl){
        port.postMessage({type:"ark:diagram-sketch",dataUrl:dataUrl});
      },fail);
    });
  }
  // "Copy as image" in the parent's toolbar: the whole board, strokes included. The parent
  // writes it to the clipboard (this sandboxed frame cannot)
  function copyPicture(){
    if(!port)return;
    if(copying||sending){port.postMessage({type:"ark:diagram-copy-error"});return;}
    copying=true;
    var reply=function(message){copying=false;if(port)port.postMessage(message);};
    probeImages(function(){
      capture(function(docWidth,docHeight){return {x:0,y:0,w:docWidth,h:docHeight};},function(crop){
        return Math.min(2,MAX_COPY_EDGE/Math.max(crop.w,crop.h),Math.sqrt(MAX_COPY_PIXELS/(crop.w*crop.h)));
      },function(dataUrl){
        reply({type:"ark:diagram-copy",dataUrl:dataUrl});
      },function(){
        reply({type:"ark:diagram-copy-error"});
      });
    });
  }
  // pick(docWidth, docHeight) is the part to take, scaleOf(crop) its scale
  function capture(pick,scaleOf,done,failed){
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
          // Keep id, class and style: the page CSS positions the canvas through them
          var attrs=originals[i].attributes;
          for(var a=0;a<attrs.length;a++)if(attrs[a].name!=="width"&&attrs[a].name!=="height")picture.setAttribute(attrs[a].name,attrs[a].value);
          picture.setAttribute("src",originals[i].toDataURL());
          picture.setAttribute("width",String(originals[i].clientWidth));
          picture.setAttribute("height",String(originals[i].clientHeight));
          copies[i].parentNode.replaceChild(picture,copies[i]);
        }catch(e){}
      }
      var drop=clone.querySelectorAll("script,ark-sketch,meta[http-equiv]");
      for(var d=0;d<drop.length;d++)if(drop[d].parentNode)drop[d].parentNode.removeChild(drop[d]);
      var xhtml=new XMLSerializer().serializeToString(clone);
      var svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+docWidth+'" height="'+docHeight+'"><foreignObject x="0" y="0" width="'+layoutWidth+'" height="'+docHeight+'" style="overflow:visible">'+xhtml+"</foreignObject></svg>";
      var crop=pick(docWidth,docHeight);
      var scale=scaleOf(crop);
      var image=new Image();
      image.onerror=failed;
      // WebKit fires load before the pictures inside the copy are decoded, and a draw made
      // right away leaves them out (drawing is what starts the decoding). So draw again after
      // a short wait, until two draws in a row come out the same
      var tries=0;
      var previous=null;
      var render=function(){
        try{
          var out=document.createElement("canvas");
          out.width=Math.round(crop.w*scale);
          out.height=Math.round(crop.h*scale);
          var c=out.getContext("2d");
          c.fillStyle="#fff";
          c.fillRect(0,0,out.width,out.height);
          c.drawImage(image,-crop.x*scale,-crop.y*scale,docWidth*scale,docHeight*scale);
          if(!paintsImages)drawPictures(c,scale,crop);
          var drawn=out.toDataURL("image/png");
          if(drawn!==previous&&tries<MAX_DRAWS){
            previous=drawn;
            tries++;
            setTimeout(render,REDRAW_WAIT);
            return;
          }
          drawStrokes(c,scale,crop.x,crop.y);
          done(out.toDataURL("image/png"));
        }catch(e){failed();}
      };
      image.onload=render;
      image.src="data:image/svg+xml;charset=utf-8,"+encodeURIComponent(svg);
    }catch(e){failed();}
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
      }else if(data.type==="ark:diagram-copy-request"){
        copyPicture();
      }else if(data.type==="ark:diagram-sketch-result"){
        // The parent attached the picture to the chat input: the strokes have done their job
        sending=false;
        if(data.ok){strokes=[];history=[];paint();setDrawing(false);}
        else sync();
      }else if(data.type==="ark:diagram-sketch-restore"&&Array.isArray(data.strokes)){
        var restored=[];
        for(var s=0;s<data.strokes.length;s++){
          var from=data.strokes[s],to=[];
          if(!Array.isArray(from))continue;
          for(var i=0;i<from.length;i++){
            var p=from[i];
            if(p&&isFinite(p.x)&&isFinite(p.y)&&isFinite(p.w))to.push({x:+p.x,y:+p.y,w:+p.w});
          }
          if(to.length)restored.push(to);
        }
        strokes=restored;
        history=[];
        paint();
        // Asked back into drawing after a reload. Set without telling the parent again
        if(typeof data.drawing==="boolean"&&data.drawing!==drawing){
          drawing=data.drawing;
          current=null;
          erasing=false;
          canvas.style.pointerEvents=drawing?"auto":"none";
        }
        sync();
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
