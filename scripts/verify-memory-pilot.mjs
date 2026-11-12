#!/usr/bin/env node
// W1-4 memory pilot: append events -> consolidate -> recall, verify hub embedder.

import { MemoryStore } from '../dist/memory/memory-store.js';
import { createMemoryEmbedder } from '../dist/memory/hub-embedder.js';
import { readFileSync } from 'node:fs';

// Load model-hub cache for embedder config
let embedder;
try {
  const cache = JSON.parse(readFileSync('./data/model-cache.json', 'utf8'));
  const primary = cache.models?.find(m => m.role === 'primary') || cache.models?.[0];
  if (primary) {
    embedder = createMemoryEmbedder({
      enabled: true,
      endpoint: {
        baseUrl: primary.base_url,
        apiKey: primary.api_key,
        model: primary.litellm_id || primary.model,
      },
    });
    console.log('# hub embedder:', primary.litellm_id || primary.model);
  }
} catch (e) {
  console.log('# cache load failed:', e.message);
}

if (!embedder) {
  embedder = createMemoryEmbedder({ enabled: false });
  console.log('# local hashing embedder (hub unavailable)');
}

const store = new MemoryStore({ embedder });

// Append events (claim format: subject-predicate-object)
const events = [
  {
    eventId: 'e1',
    realmId: 'personal',
    runId: 'run-pilot',
    source: { agentId: 'verify-script' },
    kind: 'claim',
    content: { subject: 'user', predicate: 'prefers', object: 'Chinese food for dinner' },
    refs: [],
    confidence: 0.9,
    occurredAt: new Date().toISOString(),
  },
  {
    eventId: 'e2',
    realmId: 'personal',
    runId: 'run-pilot',
    source: { agentId: 'verify-script' },
    kind: 'claim',
    content: { subject: 'user', predicate: 'lives in', object: 'Guangzhou' },
    refs: [],
    confidence: 0.95,
    occurredAt: new Date().toISOString(),
  },
];

for (const event of events) {
  store.append(event);
  console.log('# appended:', event.eventId, '-', event.content.predicate, event.content.object);
}

// Consolidate events into facts
await store.consolidateRealm('personal');
console.log('# consolidated:', events.length, 'events -> facts');

// Recall
const hits = await store.searchRecall('personal', 'personal', 'what does the user like to eat?');
console.log('# recall hits:', hits.length);
if (hits.length > 0) {
  console.log('# top hit:', hits[0].fact.subject, hits[0].fact.predicate, hits[0].fact.object);
  console.log('# lexical:', hits[0].lexical?.toFixed(3), 'semantic:', hits[0].semantic?.toFixed(3));
}

console.log('# memory pilot OK');
