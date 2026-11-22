# Local semantic source recovery

Enable **Semantic source recovery** in Study Tutor settings. It uses the configured Ollama text model; it does not install a model, require an embedding database or train on learner histories. The default remains off because hardware latency and live-model relevance have not been benchmarked here.

An optional **Local embedding model** setting accepts an installed embedding model such as `embeddinggemma`. This selects up to three passages by cosine similarity from at most 64 cited candidates, including candidates beyond the text selector's first eight. Each passage is bounded to 512 characters. Query and passage vectors are cached in memory (at most 256 vectors), keyed by model identity/digest and exact text, so changed notes and changed models invalidate corresponding entries. The four-second total budget and local-only checks still apply. A missing model, invalid vector, unknown/remote inference location or timeout leaves keyword retrieval available. No model is downloaded automatically, no whole-vault index is created, and vector similarity is not a mastery probability. Blank keeps the existing text-model selector.

The adapter uses Ollama's [`/api/embed`](https://docs.ollama.com/api/embed) batch API and the [documented cosine-similarity approach](https://docs.ollama.com/capabilities/embeddings), checked on 22 November 2026. The default similarity cutoff is a conservative product hypothesis; relevance and latency still need evaluation on each learner's notes and hardware. Tests use scripted embeddings and HTTP replies, not a live-model benchmark.

When focus-source keyword matches contain fewer than 40 words, the plugin offers up to eight bounded source snippets to the pretrained model and asks for up to three passage indices. The result is mapped to exact saved passages and retains their original IDs, revisions, citations and ordinary excerpt budgets. Existing keyword matches are retained. Normal retrieval from adequate evidence, card practice, grading and mastery updates do not invoke this selector.

The model is described before any excerpt is sent; cloud and unknown inference locations are refused. Selection has a four-second total budget including model lookup and queueing, no repair call, no cloud fallback, a 60-second failure cooldown, and a bounded in-memory result cache keyed by query, candidate content and described model/digest. The text output is limited to 64 tokens. A cache hit counts zero new prompt/output tokens. Tool Details records status, elapsed time and token counts. This is opt-in local inference and is distinct from the compilation strategy.

Selection is a relevance suggestion, not fact verification. A wrong selection is still possible. The model may abstain. Invalid/truncated output and service failures preserve lexical fallback and source-gap reporting. No generated prose becomes source evidence; selection cannot change grades or mastery. Only the focus's cited source scope is searched, so this is neither general web search nor whole-vault semantic indexing.

## Verification and limits

Scripted-provider tests cover a paraphrase missed by keyword retrieval, avoidance of inference for adequate lexical evidence, exact-source preservation, cloud/unknown refusal, content/model cache invalidation, abstention, invalid indices and timeout/cooldown. These prove pipeline behavior; they do not measure a real model's accuracy or human learning.

Before recommending that a learner leave this enabled, compare labelled paraphrases, formulas, identifiers, misleading passages and genuine gaps against lexical retrieval on their hardware. Measure relevance, false positives, latency, memory and total provider context. Candidate snippets are bounded and may miss relevant content later in a long passage or outside the first eight candidates. No speed, token-saving or learning-gain claim is made.

Neural knowledge tracing, reinforcement-learning sequencing and automated neural mastery scoring remain unimplemented. Their data/evaluation requirements are separate from using a pretrained model to locate source evidence.
