'use strict';
/* boards: node layout helpers and the random / ringworld / mega-ring board generators. */
function nodeBox(n){
 const sizes={photo:[140,92],wide:[170,100],bubble:[150,80],logo:[150,80],chart:[130,64],news:[150,84],made:[140,74],mpc:[164,96],sat:[170,90]};
 return sizes[n.shape]||[150,80];
}
function separateNodes(){
 const pad=16,minX=95,maxX=2305,minY=95,maxY=1455;
 for(let iter=0;iter<90;iter++){
  let moved=false;
  for(let i=0;i<NODES.length;i++){
   for(let j=i+1;j<NODES.length;j++){
    const A=NODES[i],B=NODES[j];
    const [aw,ah]=nodeBox(A),[bw,bh]=nodeBox(B);
    const dx=B.x-A.x,dy=B.y-A.y;
    const ox=(aw+bw)/2+pad-Math.abs(dx);
    const oy=(ah+bh)/2+pad-Math.abs(dy);
    if(ox>0&&oy>0){
     if(ox<oy){const s=dx===0?(i%2?1:-1):Math.sign(dx);const p=ox/2+.6;A.x-=s*p;B.x+=s*p}
     else{const s=dy===0?(i%2?1:-1):Math.sign(dy);const p=oy/2+.6;A.y-=s*p;B.y+=s*p}
     moved=true;
    }
   }
  }
  NODES.forEach(n=>{n.x=Math.max(minX,Math.min(maxX,n.x));n.y=Math.max(minY,Math.min(maxY,n.y))});
  if(!moved)break;
 }
}
function applyQuikSlot(slot){
 const q=NMAP.quik;if(!q||!slot)return;
 q.x=slot.x;q.y=slot.y;q.rot=slot.rot;
 EDGES=WORLD_EDGES.filter(e=>e[0]!=='quik'&&e[1]!=='quik').concat((slot.links||[]).map(id=>['quik',id]));
 rebuildAdj();
 separateNodes();
}
function applyLayoutFromState(){
 if(!S)return;
 const slot=QUIK_SLOTS[S.quikSlot|0]||QUIK_SLOTS[0];
 if(S.boardLayout){
  S.boardLayout.forEach(p=>{const n=NMAP[p.id];if(n){n.x=p.x;n.y=p.y;n.rot=p.rot}});
  EDGES=(S.boardEdges||WORLD_EDGES).map(e=>e.slice());
  rebuildAdj();
 }else applyQuikSlot(slot);
}
function generateRandomBoard(slot){
 const q=NMAP.quik;
 q.x=slot.x;q.y=slot.y;q.rot=slot.rot;
 const ids=NODES.map(n=>n.id).filter(id=>id!=='quik');
 const positions=shuffle(ORIGINAL_NODE_LAYOUT.filter(p=>p.id!=='quik').map(p=>({x:p.x,y:p.y,rot:p.rot})));
 const farthest=positions.slice().sort((a,b)=>Math.hypot(b.x-slot.x,b.y-slot.y)-Math.hypot(a.x-slot.x,a.y-slot.y));
 const basePrized=shuffle(ids.filter(id=>HIGH_VALUE_BASE_IDS.includes(id)&&id!=='made'));
 const geoPrized=shuffle(ids.filter(id=>GEO_HIGH_VALUE_IDS.includes(id)));
 const ordinary=shuffle(ids.filter(id=>!HIGH_VALUE_NODE_IDS.has(id)&&id!=='made'));
 const assignment={quik:{x:slot.x,y:slot.y,rot:slot.rot}};
 const quikPoint={x:slot.x,y:slot.y};
 assignment.made=farthest[0];
 const remaining=positions.filter(p=>p!==assignment.made);
 const basePool=remaining.slice().sort((a,b)=>Math.hypot(b.x-slot.x,b.y-slot.y)-Math.hypot(a.x-slot.x,a.y-slot.y)).slice(0,Math.ceil(positions.length*.55)); /* a wider outer-board pool preserves the prized-ring bias */
 const takeMostSpaced=(pool,anchors)=>{pool.sort((a,b)=>Math.min(...anchors.map(p=>Math.hypot(b.x-p.x,b.y-p.y)))-Math.min(...anchors.map(p=>Math.hypot(a.x-p.x,a.y-p.y))));const p=pool.shift();const at=remaining.indexOf(p);if(at>=0)remaining.splice(at,1);return p};
 const baseAnchors=[quikPoint,assignment.made];
 basePrized.forEach(id=>{const p=takeMostSpaced(basePool,baseAnchors);assignment[id]=p;baseAnchors.push(p)});
 const sortedRemaining=remaining.slice().sort((a,b)=>Math.hypot(a.x-slot.x,a.y-slot.y)-Math.hypot(b.x-slot.x,b.y-slot.y));
 const geoPool=geoPrized.length?sortedRemaining.slice(Math.floor(sortedRemaining.length*.10),Math.ceil(sortedRemaining.length*.98)):[]; /* wide outer-biased pool, max-min spaced */
 geoPrized.forEach(id=>{const p=takeMostSpaced(geoPool,baseAnchors);assignment[id]=p;baseAnchors.push(p)});
 const ordinaryPositions=shuffle(remaining);
 ordinary.forEach((id,i)=>{assignment[id]=ordinaryPositions[i]});
 NODES.forEach(n=>{const p=assignment[n.id]||ORIGINAL_LAYOUT_BY_ID[n.id];n.x=p.x;n.y=p.y;n.rot=p.rot});
 /* High-value nodes keep the max-min spacing assigned above. */
 /* Randomized nearest-neighbour spanning tree, then extra local links. */
 const order=shuffle(ids),edges=[],seen=new Set();
 const add=(a,b)=>{if(!a||!b||a===b)return;const key=[a,b].sort().join('|');if(seen.has(key))return;seen.add(key);edges.push([a,b])};
 const placed=[order[0]];
 for(let i=1;i<order.length;i++){
  const id=order[i],n=NMAP[id];
  const candidates=placed.slice().sort((a,b)=>{
   const A=NMAP[a],B=NMAP[b];
   return Math.hypot(A.x-n.x,A.y-n.y)-Math.hypot(B.x-n.x,B.y-n.y);
  }).slice(0,Math.min(5,placed.length));
  add(id,candidates[Math.floor(Math.random()*candidates.length)]);
  placed.push(id);
 }
 for(const id of ids){
  if(id==='made')continue;
  const n=NMAP[id];
  const near=ids.filter(other=>other!==id).map(other=>({id:other,d:Math.hypot(NMAP[other].x-n.x,NMAP[other].y-n.y)})).sort((a,b)=>a.d-b.d).slice(0,8);
  shuffle(near).slice(0,2+Math.floor(Math.random()*2)).forEach(v=>add(id,v.id));
 }
 const nearest=ids.map(id=>({id,d:Math.hypot(NMAP[id].x-q.x,NMAP[id].y-q.y)})).sort((a,b)=>a.d-b.d);
 nearest.slice(0,5).forEach(v=>add('quik',v.id));
 /* Cap MADE to 1-2 connections: trim extras, ensure at least one. */
 let madeEdges=edges.filter(e=>e[0]==='made'||e[1]==='made');
 if(madeEdges.length>2){const kept=[];let c=0;for(const e of edges){if(e[0]==='made'||e[1]==='made'){if(c<2){c++;kept.push(e)}}else kept.push(e)};edges.length=0;edges.push(...kept)}
 if(!edges.some(e=>e[0]==='made'||e[1]==='made')){const nearMade=ids.filter(x=>x!=='made').map(x=>({id:x,d:Math.hypot(NMAP[x].x-NMAP.made.x,NMAP[x].y-NMAP.made.y)})).sort((a,b)=>a.d-b.d)[0].id;add('made',nearMade)}
 EDGES=edges;rebuildAdj();separateNodes();
 return {positions:NODES.map(n=>({id:n.id,x:n.x,y:n.y,rot:n.rot})),edges:EDGES.map(e=>e.slice())};
}
/* Perimeter of an ellipse (Ramanujan) — used to size the three tracks. */
function ringEllipsePerimeter(rx,ry){
 const h=Math.pow((rx-ry)/(rx+ry),2);
 return Math.PI*(rx+ry)*(1+(3*h)/(10+Math.sqrt(4-3*h)));
}
/* Declare a track as a cumulative arc-length table, so nodes can be spaced by
   distance along the ellipse instead of by angle. Constant angle bunches
   neighbours together at the ends of an ellipse, where the curve is tightest. */
function ringArcTable(rx,ry,steps){
 const angles=[],cum=[0];
 let total=0,px=rx,py=0;
 for(let i=1;i<=steps;i++){
  const a=i/steps*Math.PI*2,x=Math.cos(a)*rx,y=Math.sin(a)*ry;
  total+=Math.hypot(x-px,y-py);angles.push(a);cum.push(total);px=x;py=y;
 }
 return {rx,ry,total,angles,cum};
}
function ringPointAtArc(table,fraction){
 const s=(((fraction%1)+1)%1)*table.total;
 let lo=1,hi=table.cum.length-1;
 while(lo<hi){const mid=(lo+hi)>>1;if(table.cum[mid]<s)lo=mid+1;else hi=mid}
 const i=lo,prev=table.cum[i-1],seg=(table.cum[i]-prev)||1,k=(s-prev)/seg;
 const a0=table.angles[i-1]||0,a1=table.angles[i]||a0;
 const angle=a0+(a1-a0)*k;
 return {angle,x:Math.cos(angle)*table.rx,y:Math.sin(angle)*table.ry};
}
/* Size all three tracks from the tightest one so every neighbour keeps an
   image-to-image gap, then scale the tracks together to preserve the gaps
   between rings. The canvas grows to fit the outer track. */
function ringworldMetrics(nodeCount){
 const n=Math.max(3,nodeCount|0);
 const pitch=202; /* the same 170px maximum image width + 32px clear space as Mega Ring */
 const base=[{x:1050,y:630},{x:780,y:465},{x:510,y:300}];
 const counts=base.map((_,i)=>Math.floor((n-i+2)/3)); /* rings are filled i%3 */
 let scale=1;
 base.forEach((r,i)=>{scale=Math.max(scale,pitch*counts[i]/ringEllipsePerimeter(r.x,r.y))});
 const radii=base.map(r=>({x:r.x*scale,y:r.y*scale}));
 const margin=380;
 const w=Math.ceil((radii[0].x+margin)*2/100)*100;
 const h=Math.ceil((radii[0].y+margin)*2/100)*100;
 return {x:0,y:0,w,h,cx:w/2,cy:h/2,radii,counts,scale,pitch,margin};
}
function generateRingworldBoard(){
 const ids=shuffle(NODES.map(n=>n.id).filter(id=>id!=='quik'));
 const metrics=ringworldMetrics(ids.length);
 const q=NMAP.quik;
 const cx=metrics.cx,cy=metrics.cy;
 q.x=Math.round(cx);q.y=Math.round(cy);q.rot=0;
 const rings=[[],[],[]];
 ids.forEach((id,i)=>rings[i%rings.length].push(id));
 /* half-slot and 0.65-slot offsets keep the radial links from stacking exactly */
 const phaseSlots=[0,0.5,0.65];
 rings.forEach((ring,ri)=>{
  const r=metrics.radii[ri];
  const table=ringArcTable(r.x,r.y,Math.max(360,ring.length*24));
  ring.forEach((id,i)=>{
   const pt=ringPointAtArc(table,(i+phaseSlots[ri])/ring.length);
   const x=cx+pt.x;
   const y=cy+pt.y;
   const tangent=Math.atan2(r.y*Math.cos(pt.angle),-r.x*Math.sin(pt.angle))*180/Math.PI;
   const n=NMAP[id];n.x=Math.round(x);n.y=Math.round(y);n.rot=Math.round(tangent*10)/10;
  });
 });
 const edges=[],seen=new Set();
 const add=(a,b)=>{
  if(!a||!b||a===b)return;
  const key=[a,b].sort().join('|');
  if(seen.has(key))return;
  seen.add(key);edges.push([a,b]);
 };
 // Each track is a closed loop.
 rings.forEach(ring=>{
  for(let i=0;i<ring.length;i++)add(ring[i],ring[(i+1)%ring.length]);
 });
 // Radial links connect the three loops into one traversable network.
 for(let ri=0;ri<rings.length-1;ri++){
  const outer=rings[ri],inner=rings[ri+1];
  outer.forEach((id,i)=>add(id,inner[Math.round(i*inner.length/outer.length)%inner.length]));
 }
 // Quikstop is the central hub, with four evenly spaced spokes to the inner ring.
 const inner=rings[2];
 for(let k=0;k<4;k++)add('quik',inner[Math.floor(k*inner.length/4)]);
 EDGES=edges;rebuildAdj();
 return {positions:NODES.map(n=>({id:n.id,x:n.x,y:n.y,rot:n.rot})),edges:EDGES.map(e=>e.slice())};
}
/* Size the ring from the widest exhibit so every neighbour keeps an
   image-to-image gap, including when the Geography DLC adds more nodes. */
function megaRingMetrics(nodeCount){
 const n=Math.max(3,nodeCount|0);
 const nodePitch=202; /* 170px maximum image width + at least 32px clear space */
 const radius=Math.max(2500,nodePitch/(2*Math.sin(Math.PI/n)));
 const margin=380;
 const size=Math.ceil((radius+margin)*2/100)*100;
 return {x:0,y:0,w:size,h:size,cx:size/2,cy:size/2,radius,margin};
}
function generateMegaRingBoard(){
 const ids=shuffle(NODES.map(n=>n.id).filter(id=>id!=='quik'));
 const n=ids.length;
 const map=megaRingMetrics(n);
 const q=NMAP.quik;
 q.x=map.cx;q.y=map.cy;q.rot=0;
 if(n===0){EDGES=[];rebuildAdj();return {positions:NODES.map(n=>({id:n.id,x:n.x,y:n.y,rot:n.rot})),edges:[]};}
 ids.forEach((id,i)=>{
  const angle=(Math.PI*2*i/n);
  const x=map.cx+Math.cos(angle)*map.radius;
  const y=map.cy+Math.sin(angle)*map.radius;
  const tangent=(angle+Math.PI/2)*180/Math.PI;
  const node=NMAP[id];node.x=Math.round(x);node.y=Math.round(y);node.rot=Math.round(tangent*10)/10;
 });
 const edges=[],seen=new Set();
 const add=(a,b)=>{
  if(!a||!b||a===b)return;
  const key=[a,b].sort().join('|');
  if(seen.has(key))return;
  seen.add(key);edges.push([a,b]);
 };
 for(let i=0;i<n;i++)add(ids[i],ids[(i+1)%n]);
 for(let k=0;k<4;k++)add('quik',ids[Math.floor(k*n/4)]);
 EDGES=edges;rebuildAdj();
 return {positions:NODES.map(n=>({id:n.id,x:n.x,y:n.y,rot:n.rot})),edges:EDGES.map(e=>e.slice())};
}
