export const DIAGRAM_COMMENT_LAYER_MARKER = "ark-diagram-comment-layer";

const COMMENT_LAYER = `<script id="${DIAGRAM_COMMENT_LAYER_MARKER}">
(function(){
  "use strict";
  var CARD_WIDTH=300;
  var CARD_GAP=10;
  var RAIL_GAP=12;
  var port=null;
  var pinchDistance=null;
  var comments={version:1,target:"",threads:[]};
  var pendingRequestId=null;
  var pendingAction=null;
  var pendingTimer=null;
  var operationError=null;
  var deleteConfirmThreadId=null;
  var deleteConfirmButton=null;
  var deleteConfirmTimer=null;
  var composerDraftBody="";
  var replyDraftBodies=new Map();
  var expandedThreadIds=new Set();
  // 送信はコメントの状態ではなく、その場の行為なので sidecar へ保存しない。
  // リロードで消えてよいページ内メモリとして threadId だけを覚える。
  var sentThreadIds=new Set();
  var requestSequence=0;
  var root=null;
  var anchors=[];
  var composerAnchorId=null;
  var composerAnchorQuote=null;
  var composerAnchorOccurrence=null;
  var selectedAnchorId=null;
  var selectedThreadId=null;
  var selectionAddButton=null;
  var selectionCandidate=null;
  var threadHighlightResolved=Object.create(null);
  var narrow=false;

  function element(tag,text,className){
    var value=document.createElement(tag);
    if(text!==undefined)value.textContent=text;
    if(className)value.setAttribute("class",className);
    return value;
  }
  function formatCommentTime(value){
    try{
      var date=new Date(value);
      if(Number.isNaN(date.getTime()))return value;
      return date.toLocaleString("ja-JP",{year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false});
    }catch(_error){
      return value;
    }
  }
  function clear(value){while(value.firstChild)value.removeChild(value.firstChild);}
  function requestId(){requestSequence+=1;return "comment-"+Date.now()+"-"+requestSequence;}
  function anchorEntry(anchorId){
    return anchors.filter(function(entry){return entry.anchorId===anchorId;})[0]||null;
  }
  function updatePendingControls(){
    var disableForPending=Boolean(pendingRequestId)&&!(pendingAction&&pendingAction.passive);
    root.querySelectorAll(".ark-comment-create,.ark-comment-reply,.ark-comment-resolve,.ark-comment-send,.ark-comment-delete,.ark-comment-input").forEach(function(control){
      control.disabled=disableForPending||control.getAttribute("data-sent")==="true";
    });
  }
  function clearDeleteConfirmation(){
    if(deleteConfirmTimer!==null)window.clearTimeout(deleteConfirmTimer);
    if(deleteConfirmButton){
      deleteConfirmButton.textContent="削除";
      deleteConfirmButton.setAttribute("data-confirming","false");
    }
    deleteConfirmThreadId=null;
    deleteConfirmButton=null;
    deleteConfirmTimer=null;
  }
  function rememberComposerInput(body){
    composerDraftBody=body;
  }
  function clearComposerInputs(){
    composerDraftBody="";
  }
  function captureFocusedInput(){
    var activeElement=document.activeElement;
    if(!activeElement||!root.contains(activeElement)||activeElement.tagName!=="TEXTAREA")return null;
    var replyCard=activeElement.closest(".ark-comment-card");
    var composer=activeElement.closest(".ark-comment-composer");
    if(!replyCard&&!composer)return null;
    return {
      threadId:replyCard?replyCard.getAttribute("data-thread-id"):null,
      selectionStart:activeElement.selectionStart,
      selectionEnd:activeElement.selectionEnd
    };
  }
  function send(type,payload,options){
    if(pendingRequestId){
      if(type!=="ark:diagram-comments-load"){
        operationError={
          type:type,
          anchorId:payload&&payload.anchorId,
          threadId:payload&&payload.threadId,
          message:"更新中です。もう一度お試しください"
        };
        render();
      }
      return;
    }
    if(!port){
      if(type!=="ark:diagram-comments-load"){
        operationError={
          type:type,
          anchorId:payload&&payload.anchorId,
          threadId:payload&&payload.threadId,
          message:"コメント機能に接続できていません"
        };
        render();
      }
      return;
    }
    pendingRequestId=requestId();
    pendingAction={
      type:type,
      anchorId:payload&&payload.anchorId,
      threadId:payload&&payload.threadId,
      passive:Boolean(options&&options.passive),
      focusedInput:options&&options.focusedInput||null
    };
    operationError=null;
    var message={type:type,requestId:pendingRequestId};
    Object.keys(payload||{}).forEach(function(key){message[key]=payload[key];});
    if(!pendingAction.passive)updatePendingControls();
    pendingTimer=window.setTimeout(function(){
      var timedOutAction=pendingAction;
      pendingRequestId=null;
      pendingAction=null;
      pendingTimer=null;
      updatePendingControls();
      if(timedOutAction&&timedOutAction.type!=="ark:diagram-comments-load"){
        operationError={
          type:timedOutAction.type,
          anchorId:timedOutAction.anchorId,
          threadId:timedOutAction.threadId,
          message:"応答がありません。もう一度お試しください"
        };
      }
      render(timedOutAction&&timedOutAction.focusedInput);
    },15000);
    port.postMessage(message);
  }
  function setActiveAnchor(anchorId,threadId){
    anchors.forEach(function(entry){
      if(entry.anchorId===anchorId)entry.anchor.classList.add("ark-comment-anchor-active");
      else entry.anchor.classList.remove("ark-comment-anchor-active");
    });
    root.querySelectorAll(".ark-comment-card,.ark-comment-composer").forEach(function(card){
      var active=threadId?card.getAttribute("data-thread-id")===threadId:card.getAttribute("data-anchor-id")===anchorId;
      card.setAttribute("data-active",active?"true":"false");
    });
    document.querySelectorAll(".ark-comment-highlight").forEach(function(highlight){
      highlight.setAttribute("data-active",highlight.getAttribute("data-thread-id")===threadId?"true":"false");
    });
  }
  function cardInteraction(card,anchorId,threadId){
    card.addEventListener("mouseenter",function(){setActiveAnchor(anchorId,threadId);});
    card.addEventListener("mouseleave",function(){setActiveAnchor(selectedAnchorId,selectedThreadId);});
    card.addEventListener("click",function(){
      selectedAnchorId=anchorId;
      selectedThreadId=threadId||null;
      setActiveAnchor(anchorId,selectedThreadId);
    });
  }
  function addError(container,message){
    var error=element("p",message||"コメント処理に失敗しました","ark-comment-error");
    error.setAttribute("role","alert");
    container.appendChild(error);
  }
  function hideSelectionAdd(){
    selectionCandidate=null;
    if(selectionAddButton)selectionAddButton.setAttribute("data-visible","false");
  }
  function openComposer(anchorId,anchorQuote,anchorOccurrence){
    clearComposerInputs();
    composerAnchorId=anchorId;
    composerAnchorQuote=anchorQuote||null;
    composerAnchorOccurrence=anchorQuote?(anchorOccurrence||0):null;
    selectedAnchorId=anchorId;
    selectedThreadId=null;
    operationError=null;
    hideSelectionAdd();
    render();
    var input=root.querySelector(".ark-comment-composer .ark-comment-input");
    if(input)input.focus();
  }
  function renderThread(thread){
    var entry=anchorEntry(thread.anchorId);
    var unresolved=!entry||Boolean(thread.anchorQuote&&!threadHighlightResolved[thread.id]);
    var card=element("section",undefined,"ark-comment-card");
    card.setAttribute("data-anchor-id",thread.anchorId);
    card.setAttribute("data-thread-id",thread.id);
    card.setAttribute("data-status",thread.status);
    card.setAttribute("data-unresolved",unresolved?"true":"false");
    card.setAttribute("data-collapsed",expandedThreadIds.has(thread.id)?"false":"true");
    var openCount=comments.threads.filter(function(candidate){
      return candidate.anchorId===thread.anchorId&&candidate.status==="open";
    }).length;
    var badge=element("button",String(openCount),"ark-comment-badge");
    badge.setAttribute("type","button");
    badge.setAttribute("aria-label",openCount>0?"未解決コメント "+openCount+" 件":"解決済みコメント");
    badge.addEventListener("click",function(event){
      event.stopPropagation();
      if(expandedThreadIds.has(thread.id))expandedThreadIds.delete(thread.id);
      else expandedThreadIds.add(thread.id);
      card.setAttribute("data-collapsed",expandedThreadIds.has(thread.id)?"false":"true");
      positionCards();
    });
    card.appendChild(badge);
    var content=element("div",undefined,"ark-comment-card-content");
    content.appendChild(element("strong",thread.anchorText,"ark-comment-anchor-text"));
    if(unresolved){
      content.appendChild(element("span","アンカー未解決","ark-comment-unresolved-anchor"));
      content.appendChild(element("p",thread.anchorQuote||thread.anchorText,"ark-comment-unresolved-quote"));
    }
    content.appendChild(element("span",thread.status==="open"?"未解決":"解決済み","ark-comment-state"));
    thread.messages.forEach(function(message){
      var item=element("article",undefined,"ark-comment-message");
      var time=element("time",formatCommentTime(message.at),"ark-comment-time");
      time.setAttribute("datetime",message.at);
      item.appendChild(time);
      if(message.author)item.appendChild(element("span",message.author,"ark-comment-author"));
      item.appendChild(element("p",message.body,"ark-comment-body"));
      content.appendChild(item);
    });
    if(thread.status==="open"){
      var replyInput=element("textarea",undefined,"ark-comment-input");
      replyInput.setAttribute("maxlength","4000");
      replyInput.setAttribute("placeholder","返信");
      replyInput.value=replyDraftBodies.get(thread.id)||"";
      replyInput.addEventListener("input",function(){replyDraftBodies.set(thread.id,replyInput.value);});
      content.appendChild(replyInput);
      var replyButton=element("button","返信","ark-comment-reply");
      replyButton.setAttribute("type","button");
      replyButton.addEventListener("click",function(event){
        event.stopPropagation();
        replyDraftBodies.set(thread.id,replyInput.value);
        if(!replyInput.value.trim()){
          operationError={type:"ark:diagram-comment-reply",threadId:thread.id,message:"コメント本文を入力してください"};
          render();
          return;
        }
        send("ark:diagram-comment-reply",{threadId:thread.id,body:replyInput.value});
      });
      content.appendChild(replyButton);
    }
    var actions=element("div",undefined,"ark-comment-actions");
    if(thread.status==="open"){
      var sendButton=element("button","→ Claude","ark-comment-send");
      sendButton.setAttribute("type","button");
      if(sentThreadIds.has(thread.id)){
        sendButton.textContent="送信済み";
        sendButton.setAttribute("data-sent","true");
        sendButton.disabled=true;
      }else{
        sendButton.addEventListener("click",function(event){
          event.stopPropagation();
          send("ark:diagram-comment-send",{threadId:thread.id});
        });
      }
      actions.appendChild(sendButton);
      var resolveButton=element("button","解決する","ark-comment-resolve");
      resolveButton.setAttribute("type","button");
      resolveButton.addEventListener("click",function(event){
        event.stopPropagation();
        send("ark:diagram-comment-resolve",{threadId:thread.id});
      });
      actions.appendChild(resolveButton);
    }
    var deleteButton=element("button","削除","ark-comment-delete");
    deleteButton.setAttribute("type","button");
    deleteButton.setAttribute("data-confirming","false");
    deleteButton.addEventListener("click",function(event){
      event.stopPropagation();
      if(deleteConfirmThreadId===thread.id){
        clearDeleteConfirmation();
        send("ark:diagram-comment-delete",{threadId:thread.id});
        return;
      }
      clearDeleteConfirmation();
      deleteConfirmThreadId=thread.id;
      deleteConfirmButton=deleteButton;
      deleteButton.textContent="削除する？";
      deleteButton.setAttribute("data-confirming","true");
      deleteConfirmTimer=window.setTimeout(function(){
        clearDeleteConfirmation();
      },5000);
    });
    actions.appendChild(deleteButton);
    content.appendChild(actions);
    if(operationError&&(operationError.type==="ark:diagram-comment-reply"||operationError.type==="ark:diagram-comment-resolve"||operationError.type==="ark:diagram-comment-send"||operationError.type==="ark:diagram-comment-delete")&&operationError.threadId===thread.id){
      addError(content,operationError.message);
    }
    card.appendChild(content);
    cardInteraction(card,thread.anchorId,thread.id);
    root.appendChild(card);
  }
  function renderComposer(){
    if(!composerAnchorId||!anchorEntry(composerAnchorId))return;
    var anchorId=composerAnchorId;
    var composer=element("section",undefined,"ark-comment-composer");
    composer.setAttribute("data-anchor-id",anchorId);
    var header=element("div",undefined,"ark-comment-composer-header");
    header.appendChild(element("strong","新しいコメント"));
    var closeButton=element("button","×","ark-comment-close");
    closeButton.setAttribute("type","button");
    closeButton.setAttribute("aria-label","コメント入力を閉じる");
    closeButton.addEventListener("click",function(){
      if(pendingRequestId)return;
      clearComposerInputs();
      composerAnchorId=null;
      composerAnchorQuote=null;
      composerAnchorOccurrence=null;
      operationError=null;
      render();
    });
    header.appendChild(closeButton);
    composer.appendChild(header);
    if(composerAnchorQuote){
      composer.appendChild(element("blockquote",composerAnchorQuote,"ark-comment-composer-quote"));
    }
    var bodyInput=element("textarea",undefined,"ark-comment-input");
    bodyInput.setAttribute("maxlength","4000");
    bodyInput.setAttribute("placeholder","コメント");
    bodyInput.value=composerDraftBody;
    composer.appendChild(bodyInput);
    bodyInput.addEventListener("input",function(){rememberComposerInput(bodyInput.value);});
    var createButton=element("button","コメントする","ark-comment-create");
    createButton.setAttribute("type","button");
    createButton.addEventListener("click",function(){
      rememberComposerInput(bodyInput.value);
      if(!bodyInput.value.trim()){
        operationError={type:"ark:diagram-comment-create",anchorId:anchorId,message:"コメント本文を入力してください"};
        render();
        return;
      }
      var payload=composerAnchorQuote?{
        anchorId:anchorId,
        anchorQuote:composerAnchorQuote,
        anchorOccurrence:composerAnchorOccurrence,
        body:bodyInput.value
      }:{
        anchorId:anchorId,
        body:bodyInput.value
      };
      send("ark:diagram-comment-create",payload);
    });
    var composerActions=element("div",undefined,"ark-comment-actions");
    composerActions.appendChild(createButton);
    composer.appendChild(composerActions);
    if(operationError&&operationError.type==="ark:diagram-comment-create"&&operationError.anchorId===anchorId){
      addError(composer,operationError.message);
    }
    cardInteraction(composer,anchorId,null);
    root.appendChild(composer);
  }
  function updateLayout(){
    var contentRight=null;
    // 横方向の空き幅はレイアウト更新時だけ測り、スクロールでは測らない。
    anchors.forEach(function(entry){
      var anchorRight=entry.anchor.getBoundingClientRect().right;
      contentRight=contentRight===null?anchorRight:Math.max(contentRight,anchorRight);
    });
    var availableWidth=contentRight===null?0:document.documentElement.clientWidth-contentRight;
    narrow=contentRight===null||availableWidth<CARD_WIDTH+RAIL_GAP*2;
    root.setAttribute("data-narrow",narrow?"true":"false");
  }
  function clearHighlights(){
    document.querySelectorAll('.ark-comment-highlight[data-ark-comment-owned="true"]').forEach(function(highlight){
      var parent=highlight.parentNode;
      highlight.replaceWith(document.createTextNode(highlight.textContent||""));
      if(parent&&parent.normalize)parent.normalize();
    });
    threadHighlightResolved=Object.create(null);
  }
  function collectTextNodes(anchor){
    var nodes=[];
    var text="";
    var walker=document.createTreeWalker(anchor,NodeFilter.SHOW_TEXT,{
      acceptNode:function(node){
        var parent=node.parentElement;
        if(!parent)return NodeFilter.FILTER_REJECT;
        if(parent.closest(".ark-comment-layer,script,style,noscript"))return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var node=walker.nextNode();
    while(node){
      var value=node.nodeValue||"";
      nodes.push({node:node,start:text.length,end:text.length+value.length});
      text+=value;
      node=walker.nextNode();
    }
    return {nodes:nodes,text:text};
  }
  function quoteStarts(text,quote){
    var starts=[];
    var from=0;
    while(from<=text.length-quote.length){
      var found=text.indexOf(quote,from);
      if(found<0)break;
      starts.push(found);
      from=found+1;
    }
    return starts;
  }
  function quoteStart(text,quote,occurrence){
    var starts=quoteStarts(text,quote);
    var requested=occurrence===undefined?0:occurrence;
    if(requested<starts.length)return starts[requested];
    return starts.length===1?starts[0]:null;
  }
  function activateThread(thread){
    selectedAnchorId=thread.anchorId;
    selectedThreadId=thread.id;
    expandedThreadIds.add(thread.id);
    root.querySelectorAll(".ark-comment-card").forEach(function(card){
      if(card.getAttribute("data-thread-id")===thread.id){
        card.setAttribute("data-collapsed",expandedThreadIds.has(thread.id)?"false":"true");
      }
    });
    setActiveAnchor(thread.anchorId,thread.id);
    positionCards();
  }
  function wrapThreadQuote(thread,entry){
    var snapshot=collectTextNodes(entry.anchor);
    var start=quoteStart(snapshot.text,thread.anchorQuote,thread.anchorOccurrence);
    if(start===null)return false;
    var finish=start+thread.anchorQuote.length;
    for(var index=snapshot.nodes.length-1;index>=0;index-=1){
      var part=snapshot.nodes[index];
      var overlapStart=Math.max(start,part.start);
      var overlapEnd=Math.min(finish,part.end);
      if(overlapStart>=overlapEnd)continue;
      var value=part.node.nodeValue||"";
      var localStart=overlapStart-part.start;
      var localEnd=overlapEnd-part.start;
      var highlight=element("span",undefined,"ark-comment-highlight");
      highlight.setAttribute("data-thread-id",thread.id);
      highlight.setAttribute("data-ark-comment-owned","true");
      highlight.setAttribute("data-active","false");
      highlight.appendChild(document.createTextNode(value.slice(localStart,localEnd)));
      highlight.addEventListener("mouseenter",function(){setActiveAnchor(thread.anchorId,thread.id);});
      highlight.addEventListener("mouseleave",function(){setActiveAnchor(selectedAnchorId,selectedThreadId);});
      highlight.addEventListener("click",function(event){event.stopPropagation();activateThread(thread);});
      var replacements=[];
      if(localStart>0)replacements.push(document.createTextNode(value.slice(0,localStart)));
      replacements.push(highlight);
      if(localEnd<value.length)replacements.push(document.createTextNode(value.slice(localEnd)));
      part.node.replaceWith.apply(part.node,replacements);
    }
    return true;
  }
  function renderHighlights(){
    clearHighlights();
    comments.threads.forEach(function(thread){
      if(!thread.anchorQuote)return;
      var entry=anchorEntry(thread.anchorId);
      threadHighlightResolved[thread.id]=Boolean(entry&&wrapThreadQuote(thread,entry));
    });
  }
  function positionCards(){
    var entries=[];
    var unanchored=[];
    root.querySelectorAll(".ark-comment-card,.ark-comment-composer").forEach(function(card){
      var entry=anchorEntry(card.getAttribute("data-anchor-id"));
      if(!entry){unanchored.push(card);return;}
      entries.push({card:card,anchor:entry.anchor,rect:entry.anchor.getBoundingClientRect()});
    });
    entries.sort(function(left,right){return left.rect.top-right.rect.top;});
    var viewportTop=8;
    var viewportBottom=window.innerHeight-8;
    var previousBottom=-CARD_GAP;
    entries.forEach(function(entry){
      var rect=entry.anchor.getBoundingClientRect();
      if(rect.bottom<0||rect.top>window.innerHeight){
        entry.card.style.display="none";
        return;
      }
      entry.card.style.display="block";
      var cardHeight=entry.card.offsetHeight;
      var anchorTop=Math.max(viewportTop,rect.top);
      var baseTop=anchorTop;
      var isNarrowPanel=narrow&&(
        entry.card.classList.contains("ark-comment-composer")||
        entry.card.getAttribute("data-collapsed")==="false"
      );
      if(isNarrowPanel){
        var belowTop=rect.bottom+CARD_GAP;
        var aboveTop=rect.top-cardHeight-CARD_GAP;
        if(belowTop+cardHeight<=viewportBottom)baseTop=belowTop;
        else if(aboveTop>=viewportTop)baseTop=aboveTop;
        else baseTop=Math.max(viewportTop,Math.min(belowTop,viewportBottom-cardHeight));
      }
      var cardTop=Math.max(baseTop,previousBottom+CARD_GAP);
      entry.card.style.top=cardTop+"px";
      previousBottom=cardTop+cardHeight;
    });
    unanchored.forEach(function(card){
      card.style.display="block";
      var cardTop=Math.max(8,previousBottom+CARD_GAP);
      card.style.top=cardTop+"px";
      previousBottom=cardTop+card.offsetHeight;
    });
  }
  function refreshLayout(){
    updateLayout();
    positionCards();
    updateSelectionAdd();
  }
  function cleanupExpandedThreads(){
    var existingThreadIds=new Set(comments.threads.map(function(thread){return thread.id;}));
    expandedThreadIds.forEach(function(threadId){
      if(!existingThreadIds.has(threadId))expandedThreadIds.delete(threadId);
    });
  }
  function render(focusedInput){
    clearDeleteConfirmation();
    // 無関係な再描画でも確認を押し直す方が、誤削除を防ぐ安全側の挙動になる。
    cleanupExpandedThreads();
    renderHighlights();
    root.querySelectorAll(".ark-comment-card,.ark-comment-composer").forEach(function(card){
      root.removeChild(card);
    });
    comments.threads.forEach(renderThread);
    renderComposer();
    updatePendingControls();
    updateLayout();
    setActiveAnchor(selectedAnchorId,selectedThreadId);
    window.requestAnimationFrame(positionCards);
    if(focusedInput){
      var restoredInput=null;
      if(focusedInput.threadId===null){
        restoredInput=root.querySelector(".ark-comment-composer .ark-comment-input");
      }else{
        root.querySelectorAll(".ark-comment-card").forEach(function(card){
          if(card.getAttribute("data-thread-id")===focusedInput.threadId){
            restoredInput=card.querySelector(".ark-comment-input");
          }
        });
      }
      if(restoredInput){
        var restoredLength=restoredInput.value.length;
        restoredInput.focus();
        restoredInput.setSelectionRange(
          Math.min(focusedInput.selectionStart,restoredLength),
          Math.min(focusedInput.selectionEnd,restoredLength)
        );
      }
    }
  }
  function commonSelectionAnchor(range){
    var common=range.commonAncestorContainer;
    var commonElement=common.nodeType===Node.ELEMENT_NODE?common:common.parentElement;
    if(!commonElement||commonElement.closest(".ark-comment-layer"))return null;
    return commonElement.closest("[data-ark-id]");
  }
  function boundaryTextOffset(range,snapshot,endBoundary){
    var container=endBoundary?range.endContainer:range.startContainer;
    var containerOffset=endBoundary?range.endOffset:range.startOffset;
    for(var index=0;index<snapshot.nodes.length;index+=1){
      var part=snapshot.nodes[index];
      if(part.node===container)return part.start+containerOffset;
    }
    var offset=0;
    for(var partIndex=0;partIndex<snapshot.nodes.length;partIndex+=1){
      var candidate=snapshot.nodes[partIndex];
      var relation;
      try{relation=range.comparePoint(candidate.node,0);}catch(_error){continue;}
      if(relation<0||(endBoundary&&relation===0))offset=candidate.end;
      else return endBoundary?offset:candidate.start;
    }
    return snapshot.text.length;
  }
  function selectionDetails(){
    var selection=window.getSelection();
    if(!selection||selection.rangeCount!==1||selection.isCollapsed)return null;
    var range=selection.getRangeAt(0);
    var anchor=commonSelectionAnchor(range);
    if(!anchor)return null;
    var anchorId=anchor.getAttribute("data-ark-id");
    var snapshot=collectTextNodes(anchor);
    var selectedStart=boundaryTextOffset(range,snapshot,false);
    var selectedEnd=boundaryTextOffset(range,snapshot,true);
    var quote=snapshot.text.slice(selectedStart,selectedEnd);
    if(!anchorId||quote.trim().length===0||quote.length>1000)return null;
    var starts=quoteStarts(snapshot.text,quote);
    var occurrence=starts.indexOf(selectedStart);
    if(occurrence<0)return null;
    var rect=range.getBoundingClientRect();
    if(rect.width===0&&rect.height===0)return null;
    return {anchorId:anchorId,anchorQuote:quote,anchorOccurrence:occurrence,rect:rect};
  }
  function updateSelectionAdd(){
    var details=selectionDetails();
    if(!details){hideSelectionAdd();return;}
    selectionCandidate=details;
    selectionAddButton.style.top=Math.max(8,details.rect.bottom+6)+"px";
    selectionAddButton.style.left=Math.max(8,Math.min(window.innerWidth-96,details.rect.left+details.rect.width/2-40))+"px";
    selectionAddButton.setAttribute("data-visible","true");
  }
  function buildSelectionAdd(){
    selectionAddButton=element("button","コメント","ark-comment-selection-add");
    selectionAddButton.setAttribute("type","button");
    selectionAddButton.setAttribute("data-visible","false");
    selectionAddButton.addEventListener("mousedown",function(event){event.preventDefault();});
    selectionAddButton.addEventListener("click",function(){
      if(!selectionCandidate)return;
      openComposer(selectionCandidate.anchorId,selectionCandidate.anchorQuote,selectionCandidate.anchorOccurrence);
    });
    root.appendChild(selectionAddButton);
    document.addEventListener("selectionchange",updateSelectionAdd);
    document.addEventListener("mouseup",updateSelectionAdd);
    document.addEventListener("keyup",updateSelectionAdd);
  }
  function buildAnchors(){
    document.querySelectorAll("[data-ark-id]").forEach(function(anchor){
      var anchorId=anchor.getAttribute("data-ark-id");
      if(!anchorId)return;
      anchors.push({anchor:anchor,anchorId:anchorId});
    });
  }
  function build(){
    var style=element("style");
    style.textContent=".ark-comment-layer{position:fixed;z-index:2147483000;inset:0;pointer-events:none;color:#172033;font:13px/1.5 system-ui,sans-serif}.ark-comment-card{position:fixed;right:12px;width:300px;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:9px;background:#fff;box-shadow:0 3px 14px #0002;padding:11px;pointer-events:auto}.ark-comment-composer{position:fixed;right:12px;width:300px;box-sizing:border-box;border:1px solid #93c5fd;border-radius:9px;background:#fff;box-shadow:0 3px 14px #0002;padding:11px;pointer-events:auto}.ark-comment-card[data-active=true],.ark-comment-composer[data-active=true]{border-color:#3b82f6;box-shadow:0 3px 16px #2563eb33}.ark-comment-card[data-status=resolved]{background:#f8fafc;border-color:#e2e8f0;color:#64748b;opacity:.78}.ark-comment-card[data-unresolved=true]{border-style:dashed}.ark-comment-badge{display:none}.ark-comment-card-content{display:block}.ark-comment-state,.ark-comment-time,.ark-comment-author{display:block;color:#64748b;font-size:11px}.ark-comment-unresolved-anchor{display:block;color:#b45309;font-weight:700}.ark-comment-unresolved-quote,.ark-comment-composer-quote{margin:7px 0;padding:7px;border-left:3px solid #f59e0b;background:#fffbeb;white-space:pre-wrap}.ark-comment-message{border-top:1px solid #e2e8f0;margin-top:8px;padding-top:8px}.ark-comment-body{white-space:pre-wrap}.ark-comment-input{display:block;width:100%;box-sizing:border-box;margin:7px 0;padding:7px;border:1px solid #94a3b8;border-radius:5px;font:inherit}.ark-comment-actions{display:flex;gap:8px;align-items:stretch;flex-wrap:wrap;margin-top:8px}.ark-comment-create,.ark-comment-reply,.ark-comment-resolve,.ark-comment-send{border:0;border-radius:5px;background:#2563eb;color:#fff;padding:7px 10px;cursor:pointer}.ark-comment-delete{border:0;background:transparent;color:#b91c1c;padding:7px 8px;cursor:pointer}.ark-comment-create:disabled,.ark-comment-reply:disabled,.ark-comment-resolve:disabled,.ark-comment-send:disabled,.ark-comment-delete:disabled,.ark-comment-input:disabled{opacity:.5;cursor:default}.ark-comment-error{color:#b91c1c;margin:8px 0 0}.ark-comment-composer-header{display:flex;align-items:center;justify-content:space-between}.ark-comment-close{border:0;background:transparent;color:#64748b;font-size:18px;cursor:pointer}.ark-comment-selection-add{position:fixed;z-index:2147483002;border:0;border-radius:14px;background:#2563eb;color:#fff;padding:5px 10px;box-shadow:0 2px 8px #0003;cursor:pointer;opacity:0;pointer-events:none}.ark-comment-selection-add[data-visible=true]{opacity:1;pointer-events:auto}.ark-comment-highlight{background:#fde68a;border-radius:2px;cursor:pointer}.ark-comment-highlight[data-active=true]{background:#fbbf24;box-shadow:0 0 0 2px #f59e0b55}.ark-comment-anchor-active{background-color:rgba(219,234,254,.45);outline:1px solid rgba(37,99,235,.28);outline-offset:2px}.ark-comment-layer[data-narrow=true] .ark-comment-card{right:8px;width:auto;min-width:34px;padding:0;border:0;background:transparent;box-shadow:none;opacity:1}.ark-comment-layer[data-narrow=true] .ark-comment-card[data-collapsed=true] .ark-comment-card-content{display:none}.ark-comment-layer[data-narrow=true] .ark-comment-card[data-collapsed=true] .ark-comment-badge{display:block;width:34px;height:28px;border:0;border-radius:14px;background:#2563eb;color:#fff;box-shadow:0 2px 8px #0003;cursor:pointer}.ark-comment-layer[data-narrow=true] .ark-comment-card[data-status=resolved][data-collapsed=true] .ark-comment-badge{background:#94a3b8}.ark-comment-layer[data-narrow=true] .ark-comment-card[data-collapsed=false]{width:300px;padding:11px;border:1px solid #cbd5e1;background:#fff;box-shadow:0 3px 14px #0003}.ark-comment-layer[data-narrow=true] .ark-comment-card[data-collapsed=false] .ark-comment-badge{display:none}";
    document.head.appendChild(style);
    root=element("div",undefined,"ark-comment-layer");
    root.setAttribute("data-narrow","false");
    document.body.appendChild(root);
    buildSelectionAdd();
    buildAnchors();
    render();
  }
  function onPortMessage(event){
    var data=event.data;
    if(data&&data.type==="ark:diagram-comments-changed"){
      if(pendingRequestId)return;
      var focusedInput=captureFocusedInput();
      send("ark:diagram-comments-load",{},{passive:true,focusedInput:focusedInput});
      return;
    }
    if(!data||data.type!=="ark:diagram-comments-result"||data.requestId!==pendingRequestId)return;
    var completedAction=pendingAction;
    if(pendingTimer)window.clearTimeout(pendingTimer);
    pendingTimer=null;
    pendingRequestId=null;
    pendingAction=null;
    if(data.ok){
      comments=data.comments;
      operationError=null;
      if(completedAction&&completedAction.type==="ark:diagram-comment-create"){
        clearComposerInputs();
        composerAnchorId=null;
        composerAnchorQuote=null;
        composerAnchorOccurrence=null;
      }else if(completedAction&&completedAction.type==="ark:diagram-comment-reply"){
        replyDraftBodies.delete(completedAction.threadId);
      }else if(completedAction&&completedAction.type==="ark:diagram-comment-send"){
        sentThreadIds.add(completedAction.threadId);
      }else if(completedAction&&completedAction.type==="ark:diagram-comment-delete"&&selectedThreadId===completedAction.threadId){
        selectedAnchorId=null;
        selectedThreadId=null;
      }
    }else if(completedAction&&completedAction.type!=="ark:diagram-comments-load"){
      operationError={
        type:completedAction.type,
        anchorId:completedAction.anchorId,
        threadId:completedAction.threadId,
        message:data.error||"コメント処理に失敗しました"
      };
    }
    render(completedAction&&completedAction.focusedInput);
  }
  window.addEventListener("wheel",function(event){
    if(!event.ctrlKey||!port)return;
    event.preventDefault();
    port.postMessage({type:"ark:diagram-pinch",deltaY:event.deltaY});
  },{passive:false});
  function touchDistance(event){
    var first=event.touches[0];
    var second=event.touches[1];
    return Math.hypot(first.clientX-second.clientX,first.clientY-second.clientY);
  }
  function resetTouchPinch(){pinchDistance=null;}
  function handleTouchStart(event){
    if(!port){resetTouchPinch();return;}
    if(event.touches.length!==2){resetTouchPinch();return;}
    pinchDistance=touchDistance(event);
    event.preventDefault();
  }
  function handleTouchMove(event){
    if(!port){resetTouchPinch();return;}
    if(event.touches.length!==2){resetTouchPinch();return;}
    var nextDistance=touchDistance(event);
    event.preventDefault();
    if(pinchDistance===null){pinchDistance=nextDistance;return;}
    var deltaY=-400*Math.log(nextDistance/pinchDistance);
    pinchDistance=nextDistance;
    if(port&&Number.isFinite(deltaY)&&deltaY!==0){
      port.postMessage({type:"ark:diagram-pinch",deltaY:deltaY});
    }
  }
  window.addEventListener("touchstart",handleTouchStart,{passive:false});
  window.addEventListener("touchmove",handleTouchMove,{passive:false});
  window.addEventListener("touchend",resetTouchPinch,{passive:false});
  window.addEventListener("touchcancel",resetTouchPinch,{passive:false});
  window.addEventListener("scroll",positionCards,{passive:true});
  window.addEventListener("resize",refreshLayout);
  var observer=new ResizeObserver(refreshLayout);
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
