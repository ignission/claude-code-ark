export const DIAGRAM_COMMENT_LAYER_MARKER = "ark-diagram-comment-layer";

const COMMENT_LAYER = `<script id="${DIAGRAM_COMMENT_LAYER_MARKER}">
(function(){
  "use strict";
  var port=null;
  var comments={version:1,target:"",threads:[]};
  var selectedAnchorId=null;
  var pendingRequestId=null;
  var requestSequence=0;
  var markers=[];
  var root=null;
  var content=null;
  var status=null;
  var authorInput=null;
  var bodyInput=null;
  var createButton=null;

  function element(tag,text,className){
    var value=document.createElement(tag);
    if(text!==undefined)value.textContent=text;
    if(className)value.setAttribute("class",className);
    return value;
  }
  function clear(value){while(value.firstChild)value.removeChild(value.firstChild);}
  function setStatus(message,isError){
    status.textContent=message||"";
    status.setAttribute("data-error",isError?"true":"false");
  }
  function requestId(){requestSequence+=1;return "comment-"+Date.now()+"-"+requestSequence;}
  function send(type,payload){
    if(!port||pendingRequestId)return;
    pendingRequestId=requestId();
    var message={type:type,requestId:pendingRequestId};
    Object.keys(payload||{}).forEach(function(key){message[key]=payload[key];});
    createButton.disabled=true;
    setStatus("処理中…",false);
    port.postMessage(message);
  }
  function threadForAnchor(){
    return comments.threads.filter(function(thread){return thread.anchorId===selectedAnchorId;});
  }
  function render(){
    clear(content);
    if(!selectedAnchorId){
      content.appendChild(element("p","本文右側の丸印を選択してください","ark-comment-empty"));
      return;
    }
    var heading=element("h2","コメント: "+selectedAnchorId,"ark-comment-heading");
    content.appendChild(heading);
    var threads=threadForAnchor();
    if(threads.length===0)content.appendChild(element("p","コメントはありません","ark-comment-empty"));
    threads.forEach(function(thread){
      var card=element("section",undefined,"ark-comment-thread");
      card.setAttribute("data-status",thread.status);
      card.appendChild(element("strong",thread.anchorText,"ark-comment-anchor-text"));
      card.appendChild(element("span",thread.status==="open"?"未解決":"解決済み","ark-comment-state"));
      thread.messages.forEach(function(message){
        var item=element("article",undefined,"ark-comment-message");
        item.appendChild(element("b",message.author,"ark-comment-author"));
        item.appendChild(element("time",message.at,"ark-comment-time"));
        item.appendChild(element("p",message.body,"ark-comment-body"));
        card.appendChild(item);
      });
      if(thread.status==="open"){
        var resolveButton=element("button","解決する","ark-comment-resolve");
        resolveButton.setAttribute("type","button");
        resolveButton.disabled=Boolean(pendingRequestId);
        resolveButton.addEventListener("click",function(){
          send("ark:diagram-comment-resolve",{threadId:thread.id});
        });
        card.appendChild(resolveButton);
      }
      content.appendChild(card);
    });
    var composer=element("section",undefined,"ark-comment-composer");
    composer.appendChild(element("h3","新しいコメント"));
    authorInput=element("input",undefined,"ark-comment-input");
    authorInput.setAttribute("type","text");
    authorInput.setAttribute("maxlength","80");
    authorInput.setAttribute("placeholder","名前");
    composer.appendChild(authorInput);
    bodyInput=element("textarea",undefined,"ark-comment-input");
    bodyInput.setAttribute("maxlength","4000");
    bodyInput.setAttribute("placeholder","コメント");
    composer.appendChild(bodyInput);
    createButton=element("button","コメントする","ark-comment-create");
    createButton.setAttribute("type","button");
    createButton.disabled=Boolean(pendingRequestId);
    createButton.addEventListener("click",function(){
      send("ark:diagram-comment-create",{
        anchorId:selectedAnchorId,
        author:authorInput.value,
        body:bodyInput.value
      });
    });
    composer.appendChild(createButton);
    content.appendChild(composer);
  }
  function positionMarkers(){
    markers.forEach(function(entry){
      var rect=entry.anchor.getBoundingClientRect();
      entry.marker.style.top=Math.max(8,rect.top+Math.min(rect.height/2,24))+"px";
      entry.marker.style.display=rect.bottom<0||rect.top>window.innerHeight?"none":"block";
    });
  }
  function buildMarkers(){
    document.querySelectorAll("[data-ark-id]").forEach(function(anchor){
      var anchorId=anchor.getAttribute("data-ark-id");
      if(!anchorId)return;
      var marker=element("button","●","ark-comment-marker");
      marker.setAttribute("type","button");
      marker.setAttribute("aria-label",anchorId+" のコメントを表示");
      marker.addEventListener("click",function(){selectedAnchorId=anchorId;render();});
      document.body.appendChild(marker);
      markers.push({anchor:anchor,marker:marker});
    });
    positionMarkers();
  }
  function build(){
    var style=element("style");
    style.textContent="#ark-comment-root{position:fixed;z-index:2147483000;top:0;right:0;width:320px;height:100vh;overflow:auto;background:#fff;color:#172033;border-left:1px solid #cbd5e1;box-shadow:-4px 0 14px #0002;font:13px/1.5 system-ui,sans-serif;padding:14px;box-sizing:border-box}#ark-comment-root [data-error=true]{color:#b91c1c}.ark-comment-marker{position:fixed;z-index:2147482999;right:328px;border:0;border-radius:999px;background:#2563eb;color:#fff;width:24px;height:24px;cursor:pointer}.ark-comment-thread,.ark-comment-composer{border:1px solid #dbe3ef;border-radius:8px;padding:10px;margin:10px 0}.ark-comment-state,.ark-comment-time{display:block;color:#64748b;font-size:11px}.ark-comment-message{border-top:1px solid #e2e8f0;margin-top:8px;padding-top:8px}.ark-comment-input{display:block;width:100%;box-sizing:border-box;margin:6px 0;padding:7px;border:1px solid #94a3b8;border-radius:5px}.ark-comment-create,.ark-comment-resolve{border:0;border-radius:5px;background:#2563eb;color:#fff;padding:7px 10px;cursor:pointer}.ark-comment-create:disabled,.ark-comment-resolve:disabled{opacity:.5;cursor:default}";
    document.head.appendChild(style);
    root=element("aside",undefined);
    root.setAttribute("id","ark-comment-root");
    root.setAttribute("aria-label","文書コメント");
    root.appendChild(element("h1","文書コメント"));
    status=element("p","接続待ち","ark-comment-status");
    root.appendChild(status);
    content=element("div",undefined,"ark-comment-content");
    root.appendChild(content);
    document.body.appendChild(root);
    createButton=element("button");
    render();
    buildMarkers();
  }
  function onPortMessage(event){
    var data=event.data;
    if(!data||data.type!=="ark:diagram-comments-result"||data.requestId!==pendingRequestId)return;
    pendingRequestId=null;
    if(data.ok){
      comments=data.comments;
      setStatus("最新のコメントを表示しています",false);
    }else{
      setStatus(data.error||"コメント処理に失敗しました",true);
    }
    render();
  }
  window.addEventListener("wheel",function(event){
    if(!event.ctrlKey||!port)return;
    event.preventDefault();
    port.postMessage({type:"ark:diagram-pinch",deltaY:event.deltaY});
  },{passive:false});
  window.addEventListener("scroll",positionMarkers,{passive:true});
  window.addEventListener("resize",positionMarkers);
  var observer=new ResizeObserver(positionMarkers);
  observer.observe(document.documentElement);
  window.addEventListener("message",function(event){
    if(port||!event.data||event.data.type!=="ark:diagram-init"||!event.ports||!event.ports[0])return;
    port=event.ports[0];
    port.addEventListener("message",onPortMessage);
    port.start();
    send("ark:diagram-comments-load",{});
  });
  build();
})();
</script>`;

/** 文書型ページだけへ独立したコメント層を注入する。 */
export function injectDiagramCommentLayer(html: string): string {
  if (html.includes(DIAGRAM_COMMENT_LAYER_MARKER)) return html;
  const bodyClose = html.toLowerCase().lastIndexOf("</body>");
  if (bodyClose < 0) return `${html}${COMMENT_LAYER}`;
  return `${html.slice(0, bodyClose)}${COMMENT_LAYER}${html.slice(bodyClose)}`;
}
