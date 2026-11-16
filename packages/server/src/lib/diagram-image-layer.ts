import { createCachedMinifier } from "./injected-minify.js";

export const DIAGRAM_IMAGE_LAYER_MARKER = "ark-diagram-image-layer";

/**
 * ボードの中の画像を押したら、親に渡して大きく見せる層。
 *
 * ボードの iframe はペインの大きさしかないので、中で拡大しても画面いっぱいにはならない。
 * 押された画像を data URL にして親へ送り、親が画面のほぼ全体に重ねて出す (DiagramPane.tsx)。
 *
 * - 対象は `<img>` と、本文に直接書かれた `<svg>`。`<img>` は src をそのまま送る
 *   (図は外部の画像を読めないので、src は data URL)。`<svg>` は文書の CSS で色や線が
 *   決まっていることが多いので、見た目に効くプロパティを要素へ書き込んだ写しを送る
 * - 図が自分で押せるようにしているものには手を出さない。リンク・ボタンの中、
 *   カーソルが pointer のもの、小さいもの (アイコン) は対象外
 * - 文字を選んでいる間は送らない (リンク層と同じ)
 *
 * port の扱いはリンク層 (diagram-link-layer.ts) と同じ。
 */
export const IMAGE_LAYER = `<script id="${DIAGRAM_IMAGE_LAYER_MARKER}">
(function(){
  "use strict";
  var port=null;
  var MIN_SIZE=48;
  var MAX_SVG_ELEMENTS=4000;
  var MAX_URL_LENGTH=20000000;
  // Properties that decide how an SVG looks when the page CSS is no longer there
  var STYLE_PROPS=["fill","fill-opacity","fill-rule","stroke","stroke-width","stroke-opacity","stroke-dasharray","stroke-dashoffset","stroke-linecap","stroke-linejoin","opacity","color","display","visibility","font-family","font-size","font-weight","font-style","letter-spacing","text-anchor","dominant-baseline","text-decoration","paint-order","stop-color","stop-opacity","transform","transform-origin","transform-box","clip-path","mask","filter","mix-blend-mode","marker-start","marker-mid","marker-end","vector-effect"];
  function hasTextSelection(){
    try{
      var sel=window.getSelection?window.getSelection():null;
      return !!(sel&&sel.isCollapsed===false&&String(sel).length>0);
    }catch(e){return false;}
  }
  function svgUrl(svg,rect){
    var originals=svg.querySelectorAll("*");
    if(originals.length>MAX_SVG_ELEMENTS)return null;
    var clone=svg.cloneNode(true);
    var copies=clone.querySelectorAll("*");
    function inline(from,to){
      var computed=window.getComputedStyle(from);
      var css="";
      for(var i=0;i<STYLE_PROPS.length;i++){
        var value=computed.getPropertyValue(STYLE_PROPS[i]);
        if(value)css+=STYLE_PROPS[i]+":"+value+";";
      }
      to.setAttribute("style",css);
    }
    inline(svg,clone);
    for(var i=0;i<originals.length;i++){
      var name=originals[i].localName;
      // Scripts never run inside an <img>, and foreign HTML would need the page CSS
      if(name==="script"||name==="foreignObject"){
        if(copies[i].parentNode)copies[i].parentNode.removeChild(copies[i]);
        continue;
      }
      if(name==="style"||name==="title"||name==="desc"||name==="defs")continue;
      inline(originals[i],copies[i]);
    }
    clone.setAttribute("xmlns","http://www.w3.org/2000/svg");
    clone.setAttribute("xmlns:xlink","http://www.w3.org/1999/xlink");
    if(!clone.getAttribute("viewBox"))clone.setAttribute("viewBox","0 0 "+rect.width+" "+rect.height);
    clone.setAttribute("width",String(rect.width));
    clone.setAttribute("height",String(rect.height));
    return "data:image/svg+xml;charset=utf-8,"+encodeURIComponent(new XMLSerializer().serializeToString(clone));
  }
  document.addEventListener("click",function(event){
    if(!port||event.defaultPrevented||event.button!==0)return;
    var origin=event.target;
    if(!origin||!origin.closest)return;
    if(origin.closest("a[href],button,input,select,textarea,label,summary,[role=button],[onclick],[contenteditable]"))return;
    var target=origin.closest("img,svg");
    if(!target)return;
    // The outermost <svg> is the picture; nested ones are parts of it
    while(target.localName==="svg"&&target.parentElement&&target.parentElement.closest("svg"))target=target.parentElement.closest("svg");
    var rect=target.getBoundingClientRect();
    if(rect.width<MIN_SIZE||rect.height<MIN_SIZE)return;
    if(window.getComputedStyle(origin).cursor==="pointer")return;
    if(hasTextSelection())return;
    var src=null;
    try{
      src=target.localName==="img"?(target.currentSrc||target.src):svgUrl(target,rect);
    }catch(e){src=null;}
    if(typeof src!=="string"||src.slice(0,11)!=="data:image/"||src.length>MAX_URL_LENGTH)return;
    port.postMessage({type:"ark:diagram-image",src:src,alt:target.getAttribute("alt")||target.getAttribute("aria-label")||""});
  });
  window.addEventListener("message",function(event){
    if(port||!event.data||event.data.type!=="ark:diagram-init"||!event.ports||!event.ports[0])return;
    port=event.ports[0];
    port.addEventListener("message",function(){});
    port.start();
  });
})();
</script>`;

const scriptContentStart = IMAGE_LAYER.indexOf(">") + 1;
const scriptContentEnd = IMAGE_LAYER.lastIndexOf("</script>");
const minifyImageLayerJavaScript = createCachedMinifier(
  IMAGE_LAYER.slice(scriptContentStart, scriptContentEnd),
  "js"
);

let minifiedImageLayer: string | undefined;

function getMinifiedImageLayer(): string {
  if (minifiedImageLayer === undefined) {
    minifiedImageLayer = `${IMAGE_LAYER.slice(0, scriptContentStart)}${minifyImageLayerJavaScript()}${IMAGE_LAYER.slice(scriptContentEnd)}`;
  }
  return minifiedImageLayer;
}

// 本文に marker の語が書かれているだけの板で注入が止まらないよう、実際に注入した
// <script id="..."> の有無で見る (リンク層と同じ)
const INJECTED_SCRIPT_RE = new RegExp(
  `<script[^>]*\\bid=["']${DIAGRAM_IMAGE_LAYER_MARKER}["']`,
  "i"
);

/** </body> 直前へ 1 回だけ注入する。注入済みならそのまま返す。 */
export function injectDiagramImageLayer(html: string): string {
  if (INJECTED_SCRIPT_RE.test(html)) return html;
  const layer = getMinifiedImageLayer();
  const bodyClose = html.toLowerCase().lastIndexOf("</body>");
  if (bodyClose < 0) return `${html}${layer}`;
  return `${html.slice(0, bodyClose)}${layer}${html.slice(bodyClose)}`;
}
