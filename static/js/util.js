'use strict';
/* util: pure helpers shared by every layer — no DOM, no game state. */
export const GOAL_MIN=20,GOAL_MAX=999,GOAL_DEF=100;
export function clampGoal(v){const n=Math.round(Number(v)||0);if(!n)return GOAL_DEF;return Math.max(GOAL_MIN,Math.min(GOAL_MAX,n))}
export function esc(s){return String(s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
export function shuffle(a){const r=a.slice();for(let i=r.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));const t=r[i];r[i]=r[j];r[j]=t}return r}
