// A prerequisite forest: levels follow every requires edge, including multiple parents and
// cross-topic prerequisites. Other relation types stay in the renderer without moving levels.
import type {LayoutNode, LayoutEdge, Positions} from "./graphlayout";

export function treePositions(nodes: LayoutNode[], edges: LayoutEdge[], depth: Record<string,number>, saved: Positions): Positions {
  const ids=new Set(nodes.map(n=>n.id)),byId=new Map(nodes.map(n=>[n.id,n]));
  const pre=new Map<string,string[]>(),children=new Map<string,string[]>(),parent=new Map(nodes.map(n=>[n.id,n.id]));
  const root=(id:string):string=>{let r=id;while(parent.get(r)!==r)r=parent.get(r)!;while(parent.get(id)!==id){const next=parent.get(id)!;parent.set(id,r);id=next;}return r;};
  for(const e of edges)if(e.orders&&ids.has(e.from)&&ids.has(e.to)&&e.from!==e.to){
    pre.set(e.from,[...(pre.get(e.from)??[]),e.to]);children.set(e.to,[...(children.get(e.to)??[]),e.from]);
    const a=root(e.from),b=root(e.to);if(a!==b)parent.set(a,b);
  }
  const compare=(a:string,b:string)=>{const x=byId.get(a)!.group+"\0"+a,y=byId.get(b)!.group+"\0"+b;return x<y?-1:x>y?1:0;};
  const components=new Map<string,string[]>();
  for(const n of [...nodes].sort((a,b)=>compare(a.id,b.id))){const r=root(n.id);components.set(r,[...(components.get(r)??[]),n.id]);}
  const spacing=72,layer=85;
  const blocks=[...components.values()].map(members=>{
    const rows=new Map<number,string[]>();
    for(const id of members){const d=depth[id]??0;rows.set(d,[...(rows.get(d)??[]),id]);}
    const ranks=[...rows.keys()].sort((a,b)=>a-b),positions=new Map<string,number>();
    const index=()=>{for(const row of rows.values())row.forEach((id,i)=>positions.set(id,i-(row.length-1)/2));};
    index();
    // Alternating barycentre sweeps reduce crossings without choosing one parent or
    // deleting any edge. Stable ties keep repeated layouts identical.
    for(let pass=0;pass<6;pass++){
      const neighbours=pass%2===0?pre:children;
      for(const rank of pass%2===0?ranks:[...ranks].reverse()){
        const row=rows.get(rank)!;
        const score=(id:string)=>{const ns=neighbours.get(id)??[];return ns.length?ns.reduce((sum,n)=>sum+(positions.get(n)??0),0)/ns.length:positions.get(id)??0;};
        const scores=new Map(row.map(id=>[id,score(id)]));
        row.sort((a,b)=>scores.get(a)!-scores.get(b)!||compare(a,b));index();
      }
    }
    return{members,rows,width:Math.max(...[...rows.values()].map(row=>row.length))*spacing,height:((ranks.at(-1)??0)+1)*layer};
  });
  const totalArea=blocks.reduce((sum,b)=>sum+(b.width+72)*(b.height+85),0);
  const shelfWidth=Math.max(400,Math.sqrt(totalArea)*1.6),fresh:Positions={};
  let left=0,top=0,rowHeight=0;
  for(const block of blocks){
    if(left&&left+block.width>shelfWidth){top+=rowHeight+85;left=0;rowHeight=0;}
    for(const [rank,row] of block.rows)row.forEach((id,i)=>{fresh[id]=[left+(block.width-row.length*spacing)/2+(i+0.5)*spacing,top+rank*layer];});
    left+=block.width+72;rowHeight=Math.max(rowHeight,block.height);
  }
  const out:Positions={};
  for(const n of nodes){const p=saved[n.id];if(p&&p.length===2&&p.every(Number.isFinite))out[n.id]=[p[0],p[1]];}
  // Additions extend a saved tree around its existing coordinates. Switching layouts
  // or explicitly relaying out is the only operation that moves an existing concept.
  for(const block of blocks){
    const fixed=block.members.filter(id=>out[id]);
    if(!fixed.length){for(const id of block.members)out[id]=fresh[id];continue;}
    const dx=fixed.length?fixed.reduce((sum,id)=>sum+out[id][0]-fresh[id][0],0)/fixed.length:0;
    const dy=fixed.length?fixed.reduce((sum,id)=>sum+out[id][1]-fresh[id][1],0)/fixed.length:0;
    for(const id of [...block.members].sort((a,b)=>(depth[a]??0)-(depth[b]??0)||compare(a,b))){
      if(out[id])continue;
      const parents=(pre.get(id)??[]).filter(p=>out[p]),dependents=(children.get(id)??[]).filter(p=>out[p]);
      let [x,y]=[fresh[id][0]+dx,fresh[id][1]+dy];
      if(parents.length){x=parents.reduce((sum,p)=>sum+out[p][0],0)/parents.length;y=Math.max(...parents.map(p=>out[p][1]))+layer;}
      else if(dependents.length){x=dependents.reduce((sum,p)=>sum+out[p][0],0)/dependents.length;y=Math.min(...dependents.map(p=>out[p][1]))-layer;}
      const baseX=x;let step=0;
      while(Object.values(out).some(p=>Math.abs(p[0]-x)<spacing*0.8&&Math.abs(p[1]-y)<layer*0.6)){step++;x=baseX+(step%2?1:-1)*Math.ceil(step/2)*spacing;}
      out[id]=[x,y];
    }
  }
  return out;
}
