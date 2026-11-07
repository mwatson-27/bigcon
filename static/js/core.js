'use strict';
/* core: runtime flags, the $ lookup helper and the Discord Rich Presence bridge (browser layer). Nothing runs at import time except reading location. */
/*<imports>*/
import { MAXPLAYERS, charMeta, codeSlug, matchBuzzword } from './data.js';
/*</imports>*/
export const IS_DISCORD_ACTIVITY = new URLSearchParams(location.search).get('discord') === '1' || location.hostname.endsWith('.discordsays.com') || new URLSearchParams(location.search).has('instance_id');
export const $=id=>document.getElementById(id);
/* BUILD_COMMIT is the inline classic script in index.html (the CI stamp check greps it there); a classic top-level const is visible to modules as a free identifier. */
export function initCore(){
if(IS_DISCORD_ACTIVITY)window.__BIGCON_DISCORD_ACTIVITY__=true;
$('buildStamp').textContent='COMMIT '+(typeof BUILD_COMMIT==='string'?BUILD_COMMIT:'dev');(function(){const img=$('splashLogo');if(!img)return;img.onerror=()=>{if(img.dataset.fallback)return;img.dataset.fallback='1';img.src='https://raw.githubusercontent.com/waxmotson/The-big-con-desktop/master/big%20con%20logo.png';img.alt='THE BIG CON'};})();
}

/* ================= DISCORD RICH PRESENCE BRIDGE =================
   window.discordRPC is injected ONLY by the desktop (Electron) build's
   preload.js. When this exact file is opened as a plain website — the
   original way this game runs, over PeerJS in any browser — that object
   is simply undefined, so every call below quietly does nothing and the
   web version behaves exactly as it always has. Nothing here ever talks
   to Discord directly; it only ever talks to window.discordRPC. */
export const Presence=(function(){
 let lastKey=null,startedAt=null,currentActivity=null,discordSdk=null;
 let discordAccessToken=null,lastTurnNoticeKey=null,lastGameOverNoticeKey=null;
 function bridge(){return(typeof window!=='undefined'&&window.discordRPC)||null}
 function sendToDiscord(activity){
  if(discordSdk&&discordSdk.commands&&discordSdk.commands.setActivity){
   const a={
    details:activity.details||null,
    state:activity.state||null,
    timestamps:activity.startTimestamp?{start:Math.floor(activity.startTimestamp/1000)}:null,
    assets:{
     large_image:activity.largeImageKey||null,
     large_text:activity.largeImageText||null,
     small_image:activity.smallImageKey||null,
     small_text:activity.smallImageText||null
    },
    party:activity.partyId?{id:activity.partyId,size:[activity.partySize||1,activity.partyMax||MAXPLAYERS]}:null,
    secrets:activity.joinSecret?{join:activity.joinSecret}:null,
    instance:!!activity.instance
   };
   Object.keys(a.assets).forEach(k=>{if(!a.assets[k])delete a.assets[k]});
   if(!Object.keys(a.assets).length)delete a.assets;
   Object.keys(a).forEach(k=>{if(a[k]===null)delete a[k]});
   Promise.resolve(discordSdk.commands.setActivity({activity:a})).catch(e=>console.warn('[BigCon Discord] Rich Presence update failed:',e));
   return;
  }
  const b=bridge();if(b&&b.setActivity){try{b.setActivity(activity)}catch(e){}}
 }
 function send(activity){
  currentActivity=activity;
  const key=JSON.stringify(activity);
  if(key===lastKey)return;
  lastKey=key;
  sendToDiscord(activity);
 }
 async function notifyDiscord(event){
  const channelId=discordSdk&&discordSdk.channelId;
  const instanceId=discordSdk&&discordSdk.instanceId;
  if(!channelId||!instanceId||!discordAccessToken)return;
  try{
   const response=await fetch('/relay/api/notify',{
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':'Bearer '+discordAccessToken},
    cache:'no-store',
    body:JSON.stringify({channel_id:channelId,instance_id:instanceId,event})
   });
   if(response.status===429)return; // rate limited: notifications are best-effort
   if(!response.ok){
    const data=await response.json().catch(()=>({}));
    console.warn('[BigCon Discord] Channel notification failed:',data.error||response.status);
   }
  }catch(error){console.warn('[BigCon Discord] Channel notification failed:',error)}
 }
 function withChar(p,charId){
  if(!charId)return p;
  p.smallImageKey=charId+'_big';
  const m=(typeof charMeta==='function')?charMeta(charId):null;
  p.smallImageText=m?m.name:charId;
  return p;
 }
 function joinSecretFor(code){
  const slug=codeSlug(code||'');
  return slug?('bc1.'+slug):'';
 }
 return{
  attachDiscordSDK(sdk,accessToken){discordSdk=sdk||null;discordAccessToken=accessToken||null;lastKey=null;if(currentActivity)send(currentActivity)},
  encodeJoinSecret:joinSecretFor,
  decodeJoinSecret(secret){
   let s=String(secret||'').trim();
   try{s=decodeURIComponent(s)}catch(e){}
   s=s.replace(/^secret=/i,'');
   if(/^bc1[.:]/i.test(s))s=s.slice(4);
   return matchBuzzword(s);
  },
  menu(){
   startedAt=null;lastTurnNoticeKey=null;lastGameOverNoticeKey=null;
   send({details:'In the menu',state:'Setting up the con',largeImageKey:'big_con_logo',largeImageText:'THE BIG CON'});
  },
  lobby(asHost,code,have,max,charId){
   const p={details:asHost?'Hosting a lobby':'Waiting in a lobby',state:have+'/'+max+' seated — send a Discord invite',largeImageKey:'big_con_logo',largeImageText:'THE BIG CON',partyId:'bigcon-'+(codeSlug(code)||'solo'),partySize:have,partyMax:max,supportedPlatforms:['desktop']};
   const secret=joinSecretFor(code);
   if(secret&&have<max){p.joinSecret=secret;p.instance=true}
   send(p);
  },
  inGame(turn,curName,isMe,myMoney,goal,connected,charId,code,curCharId,isHost){
   if(!startedAt)startedAt=Date.now();
   const large=curCharId?curCharId+'_big':'big_con_logo';
   const lm=(typeof charMeta==='function'&&curCharId)?charMeta(curCharId):null;
   const p={details:'Turn '+turn+' — '+curName+'’s move',state:'$'+myMoney+' of $'+goal+' target',startTimestamp:startedAt,largeImageKey:large,largeImageText:lm?lm.name:'THE BIG CON',partyId:'bigcon-'+(codeSlug(code)||'solo'),partySize:connected,partyMax:MAXPLAYERS};
   send(withChar(p,charId));
   const noticeKey=turn+':'+curName;
   if(isHost&&noticeKey!==lastTurnNoticeKey){
    lastTurnNoticeKey=noticeKey;
    notifyDiscord({type:'turn',turn,player:curName});
   }
  },
  gameOver(winnerName,winnerChar,scores){
   const large=winnerChar?winnerChar+'_big':'big_con_logo';
   const lm=(typeof charMeta==='function'&&winnerChar)?charMeta(winnerChar):null;
   send({details:'Game over',state:winnerName+' pulled off the con',largeImageKey:large,largeImageText:lm?lm.name:'THE BIG CON'});
   const resultKey=winnerName+':'+JSON.stringify(scores||[]);
   if(resultKey!==lastGameOverNoticeKey){
    lastGameOverNoticeKey=resultKey;
    notifyDiscord({type:'game_over',winner:winnerName,scores:scores||[]});
   }
  },
  clear(){
   const b=bridge();if(!b||!b.clearActivity)return;
   try{b.clearActivity()}catch(e){}
   lastKey=null;startedAt=null;
  }
 };
})();
