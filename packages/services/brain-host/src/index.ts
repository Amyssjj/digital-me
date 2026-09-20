export { loadConfig, type HostConfig } from "./config.js";
export { BrainHostRuntime, VERSION } from "./runtime.js";
export { createRequestListener, INVOKE_PATH, HEALTH_PATH } from "./http-app.js";
export { invokeTool, TOOL_NAMES, type ToolEnvelope } from "./tools.js";
export { buildIndex, ProvenanceMismatchError } from "./retriever/index-builder.js";
export { search, VectorCache, type SearchHit, type SearchResponse } from "./retriever/search.js";
export { IndexStore } from "./retriever/store.js";
export { GeminiEmbedder, HashEmbedder, type Embedder } from "./retriever/embedder.js";
export { scanCorpus, buildEntryDoc, type EntryDoc } from "./retriever/corpus.js";
