import { createCachedMinifier } from "./injected-minify.js";

export const DIAGRAM_PINCH_LAYER_MARKER = "ark-diagram-pinch-layer";

/**
 * ボードの中のピンチを親へ渡す層。
 *
 * ボードの iframe は sandbox で出どころが別なので、ピンチ (トラックパッドの Ctrl+ホイールと、
 * 2 本指のタッチ) は親の window に届かず、親は中の document にも触れない。ここで量だけを
 * 親へ送り、拡大縮小は親が iframe ごと行う (DiagramPane.tsx)。
 *
 * port の扱いはリンク層 (diagram-link-layer.ts) と同じ。
 */
export const PINCH_LAYER = `<script id="${DIAGRAM_PINCH_LAYER_MARKER}">
(function(){
  "use strict";
  var port=null;
  window.addEventListener("wheel",function(event){
    if(!event.ctrlKey||!port)return;
    event.preventDefault();
    port.postMessage({type:"ark:diagram-pinch",deltaY:event.deltaY,clientX:event.clientX,clientY:event.clientY});
  },{passive:false});
  var pinchDistance=null;
  function touchDistance(event){
    var a=event.touches[0],b=event.touches[1];
    return Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY);
  }
  function resetPinch(){pinchDistance=null;}
  window.addEventListener("touchstart",function(event){
    if(!port||event.touches.length!==2){resetPinch();return;}
    pinchDistance=touchDistance(event);
    event.preventDefault();
  },{passive:false});
  window.addEventListener("touchmove",function(event){
    if(!port||event.touches.length!==2){resetPinch();return;}
    var next=touchDistance(event);
    event.preventDefault();
    if(pinchDistance===null){pinchDistance=next;return;}
    var deltaY=-400*Math.log(next/pinchDistance);
    pinchDistance=next;
    if(Number.isFinite(deltaY)&&deltaY!==0)port.postMessage({type:"ark:diagram-pinch",deltaY:deltaY});
  },{passive:false});
  window.addEventListener("touchend",resetPinch,{passive:false});
  window.addEventListener("touchcancel",resetPinch,{passive:false});
  window.addEventListener("message",function(event){
    if(port||!event.data||event.data.type!=="ark:diagram-init"||!event.ports||!event.ports[0])return;
    port=event.ports[0];
    port.start();
  });
})();
</script>`;

const scriptContentStart = PINCH_LAYER.indexOf(">") + 1;
const scriptContentEnd = PINCH_LAYER.lastIndexOf("</script>");
const minifyPinchLayerJavaScript = createCachedMinifier(
  PINCH_LAYER.slice(scriptContentStart, scriptContentEnd),
  "js"
);

let minifiedPinchLayer: string | undefined;

function getMinifiedPinchLayer(): string {
  if (minifiedPinchLayer === undefined) {
    minifiedPinchLayer = `${PINCH_LAYER.slice(0, scriptContentStart)}${minifyPinchLayerJavaScript()}${PINCH_LAYER.slice(scriptContentEnd)}`;
  }
  return minifiedPinchLayer;
}

// 本文に marker の語が書かれているだけの板で注入が止まらないよう、実際に注入した
// <script id="..."> の有無で見る (リンク層と同じ)
const INJECTED_SCRIPT_RE = new RegExp(
  `<script[^>]*\\bid=["']${DIAGRAM_PINCH_LAYER_MARKER}["']`,
  "i"
);

/** </body> 直前へ 1 回だけ注入する。注入済みならそのまま返す。 */
export function injectDiagramPinchLayer(html: string): string {
  if (INJECTED_SCRIPT_RE.test(html)) return html;
  const layer = getMinifiedPinchLayer();
  const bodyClose = html.toLowerCase().lastIndexOf("</body>");
  if (bodyClose < 0) return `${html}${layer}`;
  return `${html.slice(0, bodyClose)}${layer}${html.slice(bodyClose)}`;
}
