import { describe, expect, it } from 'vitest';
import { sendTaskSubscribe } from '../src/dispatch/client.js';
import { isFilePart, artifactFileUris } from '../src/a2a/parts.js';
import type { A2AEvent, Task } from '../src/a2a/types.js';

function sse(events: unknown[], finalTask: Task): Response {
  const chunks = [
    ...events.map(event => `data: ${JSON.stringify({ jsonrpc: '2.0', id: 2, result: event })}\n\n`),
    `data: ${JSON.stringify({ jsonrpc: '2.0', id: 2, result: finalTask })}\n\n`,
  ];
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
  );
}

describe('A2A file/URI parts and task history', () => {
  it('isFilePart / artifactFileUris recognize only the URI reference form', () => {
    const artifact = {
      artifactId: 'a1',
      name: 'mixed',
      parts: [
        { kind: 'text', text: 'notes' },
        { kind: 'data', data: { k: 1 } },
        { kind: 'file', file: { uri: 'file://a/b.pdf', name: 'b.pdf' } },
        { kind: 'file', file: { name: 'no-uri' } },
      ],
    } as Task['artifacts'][number];

    expect(artifact.parts.filter(isFilePart)).toHaveLength(1);
    expect(artifactFileUris(artifact)).toEqual(['file://a/b.pdf']);
  });

  it('passes file/URI artifact parts through SSE and preserves loose task history', async () => {
    const finalTask: Task = {
      kind: 'task',
      id: 'task-1',
      contextId: 'ctx',
      status: { state: 'completed' },
      artifacts: [
        {
          artifactId: 'a1',
          name: 'deliverable',
          parts: [
            { kind: 'text', text: 'quarterly report' },
            { kind: 'file', file: { uri: 'file://reports/q3.pdf', name: 'q3.pdf', mimeType: 'application/pdf' } },
          ],
        },
      ],
      history: [
        { role: 'user', parts: [{ kind: 'text', text: 'run the report' }] },
        { role: 'agent', parts: [{ kind: 'text', text: 'working on it' }] },
      ],
    };
    const streamed: A2AEvent[] = [];
    const fetchImpl = async (): Promise<Response> =>
      sse(
        [{ kind: 'artifact-update', taskId: 'task-1', contextId: 'ctx', artifact: finalTask.artifacts[0] }],
        finalTask
      );

    const task = await sendTaskSubscribe(
      { taskUrl: 'http://vassal.internal/api/a2a/tasks', skill: 'report', params: {}, runId: 'r1' },
      { onEvent: event => streamed.push(event) },
      fetchImpl
    );

    // file part survives the streamed artifact-update event
    expect(streamed).toHaveLength(1);
    const streamedArtifact = (streamed[0] as { artifact: Task['artifacts'][number] }).artifact;
    expect(artifactFileUris(streamedArtifact)).toEqual(['file://reports/q3.pdf']);

    // file part and loose history survive the final task snapshot
    expect(artifactFileUris(task.artifacts[0])).toEqual(['file://reports/q3.pdf']);
    expect(task.history).toHaveLength(2);
    expect(task.history?.[0]).toMatchObject({ role: 'user' });
  });
});
