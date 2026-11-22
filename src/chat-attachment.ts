import {fmStr, type Chat} from './formats';
import type {Material} from './engine-common';

/** Keep exact attachment text with its chat for retries/restarts; never merge it into a graded answer. */
export function chatAttachment(chat: Chat, supplied?: Material): Material | undefined {
  if (supplied) {
    chat.fm.attachment = JSON.stringify({name:supplied.name,text:supplied.text});
    return supplied;
  }
  try {
    const raw=fmStr(chat.fm,'attachment');
    if (!raw || raw.length>1024*1024) return undefined;
    const value:unknown=JSON.parse(raw);
    if (!value || typeof value!=='object') return undefined;
    const item=value as Record<string,unknown>;
    return typeof item.name==='string' && item.name.length<=1000 && typeof item.text==='string' && new TextEncoder().encode(item.text).length<=128*1024 ? {name:item.name,text:item.text}:undefined;
  } catch {return undefined;}
}
