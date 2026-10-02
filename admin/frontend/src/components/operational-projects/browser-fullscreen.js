// Fullscreen changes presentation only. The browser element and live transport
// stay mounted, so entering/exiting cannot create another viewer or controller.
export function createBrowserFullscreen({element,onChange=()=>{},documentImpl=globalThis.document}) {
  let active=false,disposed=false,opener=null,restores=[],native=false,generation=0;
  const focusables=()=>[...element.querySelectorAll('button,[href],input,select,textarea,[tabindex]')].filter(el=>!el.disabled&&el.tabIndex>=0&&el.getClientRects().length);
  function restore(){for(const [el,prior]of restores)el.inert=prior;restores=[];if(opener?.isConnected)opener.focus({preventScroll:true});}
  function update(next){if(disposed||active===next)return;active=next;onChange(next);if(!next){native=false;restore();}}
  async function exit(){generation++;if(documentImpl.fullscreenElement===element)try{await documentImpl.exitFullscreen();}catch{/* CSS fallback still exits. */}update(false);}
  const key=event=>{
    if(!active)return;
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();void exit();return;}
    if(event.key!=='Tab')return;
    const targets=focusables(),first=targets[0],last=targets.at(-1),current=documentImpl.activeElement;
    if(!first){event.preventDefault();element.focus();}
    else if(event.shiftKey&&(current===first||!element.contains(current))){event.preventDefault();last.focus();}
    else if(!event.shiftKey&&(current===last||!element.contains(current))){event.preventDefault();first.focus();}
  };
  const changed=()=>{if(documentImpl.fullscreenElement===element){native=true;update(true);}else if(native)update(false);};
  documentImpl.addEventListener('keydown',key,true);documentImpl.addEventListener('fullscreenchange',changed);
  return {
    async enter(){if(disposed||active)return;const current=++generation;opener=documentImpl.activeElement;
      for(let node=element;node?.parentElement;node=node.parentElement)for(const sibling of node.parentElement.children)if(sibling!==node){restores.push([sibling,sibling.inert]);sibling.inert=true;}
      update(true);try{if(typeof element.requestFullscreen==='function'){await element.requestFullscreen();native=documentImpl.fullscreenElement===element;}}catch{/* Phone/API refusal uses the same fixed viewport surface. */}
      await new Promise(resolve=>setTimeout(resolve,0));
      if(current!==generation||disposed){if(documentImpl.fullscreenElement===element)try{await documentImpl.exitFullscreen();}catch{}return;}
      if(active)(element.querySelector('[data-exit-browser-fullscreen]')||element).focus({preventScroll:true});
    },exit,
    close(){if(disposed)return;generation++;documentImpl.removeEventListener('keydown',key,true);documentImpl.removeEventListener('fullscreenchange',changed);if(documentImpl.fullscreenElement===element)void documentImpl.exitFullscreen().catch(()=>{});if(active)restore();active=false;disposed=true;},
  };
}
