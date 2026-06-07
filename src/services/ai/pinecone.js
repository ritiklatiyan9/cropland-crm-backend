// Pinecone vector store — managed RAG retrieval for Train AI Doctor.
//
// Vectors are Gemini text-embedding-004 embeddings (768-dim) built from each
// trained photo's "label · vision caption". Pinecone replaces the previous
// in-memory cosine scan so retrieval scales to large training sets and stays
// fast. The whole module degrades gracefully: when PINECONE_API_KEY is unset
// (or any call fails), callers fall back to the Postgres/in-memory path and the
// app keeps working — Pinecone is an accelerator, never a hard dependency.

import { Pinecone } from '@pinecone-database/pinecone';
import { env } from '../../config/env.js';

const CFG = env.pinecone;
export const pineconeConfigured = Boolean(CFG.apiKey);

let clientPromise = null; // memoised Pinecone client
let indexReady = null; // memoised "index exists & is ready" promise

function getClient() {
  if (!pineconeConfigured) return null;
  if (!clientPromise) clientPromise = Promise.resolve(new Pinecone({ apiKey: CFG.apiKey }));
  return clientPromise;
}

// Create the serverless index on first use if it doesn't exist, then wait until
// it reports ready. Memoised so concurrent callers share one bootstrap.
async function ensureIndex(pc) {
  if (indexReady) return indexReady;
  indexReady = (async () => {
    const existing = await pc.listIndexes();
    const found = (existing.indexes ?? []).some((i) => i.name === CFG.indexName);
    if (!found) {
      await pc.createIndex({
        name: CFG.indexName,
        dimension: env.ai.embeddingDim, // 768 — Gemini text-embedding-004
        metric: 'cosine',
        spec: { serverless: { cloud: CFG.cloud, region: CFG.region } },
        waitUntilReady: true,
      });
    } else {
      // Poll briefly until the index is ready to serve.
      for (let i = 0; i < 30; i += 1) {
        const desc = await pc.describeIndex(CFG.indexName);
        if (desc.status?.ready) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    return true;
  })().catch((err) => {
    indexReady = null; // allow a later retry
    throw err;
  });
  return indexReady;
}

async function getIndex() {
  const pc = await getClient();
  if (!pc) return null;
  await ensureIndex(pc);
  return pc.index(CFG.indexName).namespace(CFG.namespace);
}

/**
 * Upsert one training sample's vector. `metadata` is stored alongside so query
 * results carry everything the diagnosis prompt needs (no DB round-trip).
 * Returns true on success, false when Pinecone is unconfigured/unavailable.
 */
export async function upsertSample(id, vector, metadata = {}) {
  if (!pineconeConfigured || !Array.isArray(vector) || !vector.length) return false;
  try {
    const index = await getIndex();
    // Pinecone metadata rejects null/undefined values — strip them.
    const meta = Object.fromEntries(Object.entries(metadata).filter(([, v]) => v != null && v !== ''));
    await index.upsert({ records: [{ id: String(id), values: vector, metadata: meta }] });
    return true;
  } catch (err) {
    console.error('[pinecone] upsert failed:', err.message);
    return false;
  }
}

/** Delete one or more sample vectors by id. Safe no-op when unconfigured. */
export async function deleteSamples(ids) {
  const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean).map(String);
  if (!pineconeConfigured || !list.length) return false;
  try {
    const index = await getIndex();
    await index.deleteMany({ ids: list });
    return true;
  } catch (err) {
    console.error('[pinecone] delete failed:', err.message);
    return false;
  }
}

/**
 * Retrieve the most similar trained samples to a query vector, optionally
 * filtered to one crop. Returns [{ id, score, metadata }] (highest score first)
 * or null when Pinecone is unconfigured/unavailable so the caller can fall back.
 */
export async function querySimilar(vector, { crop, topK = 4 } = {}) {
  if (!pineconeConfigured || !Array.isArray(vector) || !vector.length) return null;
  try {
    const index = await getIndex();
    const filter = crop ? { crop: { $eq: String(crop).toLowerCase() } } : undefined;
    const res = await index.query({ vector, topK, includeMetadata: true, filter });
    return (res.matches ?? []).map((m) => ({ id: m.id, score: m.score ?? 0, metadata: m.metadata ?? {} }));
  } catch (err) {
    console.error('[pinecone] query failed:', err.message);
    return null;
  }
}

/** Index health/stats for the Train AI Doctor status panel. */
export async function vectorStoreStatus() {
  const base = {
    provider: 'pinecone',
    configured: pineconeConfigured,
    index: CFG.indexName,
    namespace: CFG.namespace,
    ready: false,
    vectorCount: null,
  };
  if (!pineconeConfigured) return base;
  try {
    const pc = await getClient();
    await ensureIndex(pc);
    const stats = await pc.index(CFG.indexName).describeIndexStats();
    const ns = stats.namespaces?.[CFG.namespace];
    return { ...base, ready: true, vectorCount: ns?.recordCount ?? stats.totalRecordCount ?? 0 };
  } catch (err) {
    return { ...base, ready: false, error: err.message };
  }
}
