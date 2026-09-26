import { createCachedMinifier } from "./injected-minify.js";

export const DIAGRAM_LINK_LAYER_MARKER = "ark-diagram-link-layer";

/**
 * ボード内の <a href> を横取りして親へ渡す層。
 *
 * sandbox="allow-scripts" の iframe で <a> をそのまま踏むと iframe ごと遷移し、
 * DiagramPane はそれを「別ページへの遷移」と見てコメント層との接続を切る。
 * ここで遷移を止め、href の生の値だけを親へ送る。解釈 (worktree 相対パスか、
 * 外部 URL か) は親 (DiagramPane) が行う。
 *
 * port は他の層と同じく window の ark:diagram-init で受け取り、共有する。
 */
export const LINK_LAYER = `<script id="${DIAGRAM_LINK_LAYER_MARKER}">
(function(){
  "use strict";
  var port=null;
  function schemeOf(href){
    var m=/^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(href);
    return m?m[1].toLowerCase():"";
  }
  document.addEventListener("click",function(event){
    var target=event.target&&event.target.closest?event.target.closest("a[href]"):null;
    if(!target)return;
    var href=target.getAttribute("href");
    if(href==null)return;
    if(href.charAt(0)==="#")return;
    event.preventDefault();
    var scheme=schemeOf(href);
    if(scheme&&scheme!=="http"&&scheme!=="https")return;
    if(!port)return;
    port.postMessage({type:"ark:diagram-open-link",href:href});
  },true);
  window.addEventListener("message",function(event){
    if(port||!event.data||event.data.type!=="ark:diagram-init"||!event.ports||!event.ports[0])return;
    port=event.ports[0];
    port.addEventListener("message",function(){});
    port.start();
  });
})();
</script>`;

const scriptContentStart = LINK_LAYER.indexOf(">") + 1;
const scriptContentEnd = LINK_LAYER.lastIndexOf("</script>");
const minifyLinkLayerJavaScript = createCachedMinifier(
  LINK_LAYER.slice(scriptContentStart, scriptContentEnd),
  "js"
);

let minifiedLinkLayer: string | undefined;

function getMinifiedLinkLayer(): string {
  if (minifiedLinkLayer === undefined) {
    minifiedLinkLayer = `${LINK_LAYER.slice(0, scriptContentStart)}${minifyLinkLayerJavaScript()}${LINK_LAYER.slice(scriptContentEnd)}`;
  }
  return minifiedLinkLayer;
}

// 注入済みの判定は marker の bare な includes() ではなく、実際に注入された
// <script id="..."> タグの有無で行う。本文に marker の語が書かれているだけの
// 板が無言で二度と注入されなくなる事故を避ける (doc editor と同じ堅さ)
const INJECTED_SCRIPT_RE = new RegExp(
  `<script[^>]*\\bid=["']${DIAGRAM_LINK_LAYER_MARKER}["']`,
  "i"
);

/** </body> 直前へ 1 回だけ注入する。注入済みならそのまま返す。 */
export function injectDiagramLinkLayer(html: string): string {
  if (INJECTED_SCRIPT_RE.test(html)) return html;
  const layer = getMinifiedLinkLayer();
  const bodyClose = html.toLowerCase().lastIndexOf("</body>");
  if (bodyClose < 0) return `${html}${layer}`;
  return `${html.slice(0, bodyClose)}${layer}${html.slice(bodyClose)}`;
}
