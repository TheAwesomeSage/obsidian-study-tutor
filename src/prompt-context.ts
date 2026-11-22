import type { Chat } from "./formats";
import type { SessionRecord } from "./session";

/** Remove only byte-for-byte duplicate excerpts that are already in this prompt's full chat. */
export function sessionForPrompt(session: SessionRecord, chat: Chat): Omit<SessionRecord, "exactExcerpts"> & { exactExcerpts?: string[] } {
  const messages = new Set(chat.messages.map(m => `${m.role}: ${m.text}`));
  const {exactExcerpts, ...rest} = session;
  const unique = exactExcerpts.filter(excerpt => !messages.has(excerpt));
  return unique.length ? {...rest, exactExcerpts: unique} : rest;
}
