// Pretrained local embeddings recover paraphrases within the same cited-source scope.
// Similarity ranks saved passage IDs; it never writes teaching, grades or learner evidence.
import {cloudModelName,type LocalEmbeddingModel} from "./ollama";
import type {PassageSelector,SemanticCandidate,SemanticSelection} from "./semantic-retrieval";

export const EMBEDDING_CANDIDATES=64;
export const EMBEDDING_MIN_SCORE=0.45; // Conservative product default; not a mastery probability.

export class EmbeddingPassageSelector implements PassageSelector {
  private vectors=new Map<string,number[]>();
  private busy=false;
  private retryAfter=0;
  constructor(private model:LocalEmbeddingModel,private budgetMs=4000){}

  async select(query:string,input:SemanticCandidate[]):Promise<SemanticSelection>{
    const start=Date.now();
    const base=():SemanticSelection=>({ids:[],status:"unavailable",model:this.model.model,cacheHit:false,wallMs:Date.now()-start,promptTokens:0,outputTokens:0});
    if(this.busy||start<this.retryAfter||cloudModelName(this.model.model)||!query.trim()||!input.length)return base();
    this.busy=true;
    const ctl=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      const work=async():Promise<SemanticSelection>=>{
        const info=await this.model.describe(ctl.signal);
        if(info.runs!=="local"||ctl.signal.aborted){this.retryAfter=Date.now()+60000;return base();}
        const candidates=input.slice(0,EMBEDDING_CANDIDATES).map(p=>({id:p.id,text:p.text.slice(0,512)}));
        const texts=[query.slice(0,500),...candidates.map(p=>p.text)];
        const keys=texts.map((t,i)=>JSON.stringify([info.model,info.digest,i===0?"query":"passage",t]));
        const missing=[...new Set(keys.filter(k=>!this.vectors.has(k)))];
        let tokens=0;
        const pending=new Map<string,number[]>();
        if(missing.length){
          const reply=await this.model.embed(missing.map(k=>texts[keys.indexOf(k)]),{signal:ctl.signal,timeoutMs:this.budgetMs});
          if(ctl.signal.aborted)throw new Error("Embedding search timed out");
          if(reply.vectors.length!==missing.length)throw new Error("Missing embeddings");
          reply.vectors.forEach((v,i)=>pending.set(missing[i],v));tokens=reply.inputTokens;
        }
        const vector=(key:string)=>pending.get(key)??this.vectors.get(key)!;
        const q=vector(keys[0]);
        const norm=(v:number[])=>Math.sqrt(v.reduce((sum,x)=>sum+x*x,0));
        const qn=norm(q);
        if(!qn||!Number.isFinite(qn)||q.length>4096||!q.every(Number.isFinite))throw new Error("Invalid query embedding");
        const scores=candidates.map((p,i)=>{
          const v=vector(keys[i+1]),vn=norm(v);
          if(v.length!==q.length||!vn||!Number.isFinite(vn)||!v.every(Number.isFinite))throw new Error("Invalid passage embedding");
          return{id:p.id,score:v.reduce((sum,x,j)=>sum+x*q[j],0)/(vn*qn),order:i};
        }).sort((a,b)=>b.score-a.score||a.order-b.order);
        if(ctl.signal.aborted)throw new Error("Embedding search cancelled");
        // Commit only completed, validated vectors. No persisted cache or vault scan.
        for(const [key,value] of pending)this.vectors.set(key,value);
        while(this.vectors.size>256)this.vectors.delete(this.vectors.keys().next().value!);
        const ids=[...new Set(scores.filter(p=>p.score>=EMBEDDING_MIN_SCORE).map(p=>p.id))].slice(0,3);
        return{...base(),ids,status:ids.length?"selected":"abstained",cacheHit:missing.length===0,promptTokens:tokens};
      };
      return await Promise.race([work(),new Promise<SemanticSelection>((_,reject)=>{timer=setTimeout(()=>{ctl.abort();reject(new Error("Embedding budget exceeded"));},this.budgetMs);})]);
    }catch{this.retryAfter=Date.now()+60000;return base();}
    finally{if(timer)clearTimeout(timer);this.busy=false;}
  }
}
