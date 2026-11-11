/**
 * End to end through the real CLI: a temp project with a cortex DB, a stub
 * OpenAI-compatible server for both the answering and the judging model, and
 * the documented sequence validate → answer (cortex, none) → score.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemory } from '../core/types.js';
import { insertMemory, openDatabase } from '../infra/db.js';

const CLI = fileURLToPath(new URL('../cli.ts', import.meta.url));
const TRUTH = 'claude-sonnet-5.5';

let root: string;
let project: string;
let server: ReturnType<typeof Bun.serve>;
const prompts: string[] = [];

/** Answers from memory when memory holds the truth; judges by whether the answer has it. */
function stubReply(prompt: string): string {
  if (prompt.startsWith('You are scoring one answer')) {
    const answer = prompt.slice(prompt.indexOf('<answer>'), prompt.indexOf('</answer>'));
    const score = answer.includes(TRUTH) ? 1 : 0;
    return JSON.stringify({
      correct_current: score,
      relevant: score,
      missed: score,
      ordered: score,
      context_complete: score,
      reason: 'stub',
    });
  }
  const memory = prompt.slice(prompt.indexOf('<memory_context>'), prompt.indexOf('</memory_context>'));
  return memory.includes(TRUTH) ? `Reclaw runs pi on ${TRUTH}.` : 'My memory does not say.';
}

function memory(id: string, summary: string, session: string) {
  return createMemory({
    id,
    content: summary,
    summary,
    memory_type: 'decision',
    scope: 'project',
    confidence: 0.9,
    priority: 9,
    source_type: 'extraction',
    source_session: session,
    source_context: '{}',
    tags: [],
    status: 'active',
  });
}

async function cli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const url = `http://127.0.0.1:${server.port}/v1`;
  const proc = Bun.spawn(['bun', CLI, 'eval', ...args, `--cwd=${project}`], {
    env: {
      ...process.env,
      HOME: path.join(root, 'home'),
      CORTEX_EVAL_ANSWER_API_URL: url,
      CORTEX_EVAL_ANSWER_API_KEY: 'k',
      CORTEX_EVAL_ANSWER_MODEL: 'stub-answer',
      CORTEX_EVAL_JUDGE_API_URL: url,
      CORTEX_EVAL_JUDGE_API_KEY: 'k',
      CORTEX_EVAL_JUDGE_MODEL: 'stub-judge',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/** A failed step shows the CLI's own error output, not just its exit code. */
function expectOk(result: { code: number; stderr: string }): void {
  expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: expect.any(String) });
}

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'cortex-eval-e2e-'));
  project = path.join(root, 'project');
  mkdirSync(path.join(project, '.memory', 'eval'), { recursive: true });

  const db = openDatabase(path.join(project, '.memory', 'cortex.db'));
  insertMemory(db, memory('real', `Reclaw runs pi on ${TRUTH} since 2026-10-26`, 'work-session'));
  insertMemory(db, memory('leak', 'EVAL ANSWER KEY for the reclaw question', 'author-session'));
  db.close();

  const evalDir = path.join(project, '.memory', 'eval');
  writeFileSync(path.join(evalDir, 'eval.json'), JSON.stringify({ authoring_sessions: ['author-session'] }));
  writeFileSync(
    path.join(evalDir, 'questions.jsonl'),
    [
      { id: 'q1', split: 'practice', question: 'Which model does reclaw run pi on?' },
      { id: 'q2', split: 'held_out', question: 'Set up reclaw: which pi model should it use?' },
    ]
      .map((q) =>
        JSON.stringify({ ...q, kind: 'changed_value', asked_on: '2026-10-26', true_now: [TRUTH], stale: ['claude-sonnet-5'] }),
      )
      .join('\n'),
  );

  server = Bun.serve({
    port: 0,
    async fetch(req: Request) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/models')) return Response.json({ data: [] });
      const body = (await req.json()) as { messages: { content: string }[]; model: string };
      const prompt = body.messages[0].content;
      prompts.push(prompt);
      return Response.json({
        model: `${body.model}-served`,
        usage: { prompt_tokens: prompt.length, completion_tokens: 10 },
        choices: [{ message: { content: stubReply(prompt) }, finish_reason: 'stop' }],
      });
    },
  });
});

afterAll(() => {
  server?.stop(true);
  rmSync(root, { recursive: true, force: true });
});

describe('cortex eval, end to end', () => {
  test('validate summarizes the set and warns about its size', async () => {
    const { code, stdout, stderr } = await cli('validate');
    expectOk({ code, stderr });
    expect(stdout).toContain('2 cases: 1 practice, 1 held_out');
    expect(stdout).toContain('authoring sessions excluded from memory reads: 1');
    expect(stdout).toContain('the method calls for about 20');
  }, 60_000);

  test('answer, score and compare: memory beats no memory, and the answer key never leaks', async () => {
    const withMemory = await cli('answer', 'cortex-1');
    expect(withMemory.stderr).not.toContain('FAILED');
    expectOk(withMemory);
    expect(withMemory.stdout).toContain('run cortex-1 (cortex): 2 answered now, 0 already answered; 1 authoring-session memories excluded');

    const baseline = await cli('answer', 'none-1', '--condition=none');
    expectOk(baseline);

    const again = await cli('answer', 'cortex-1');
    expect(again.stdout).toContain('0 answered now, 2 already answered');

    const scored = await cli('score', 'none-1', 'cortex-1');
    expectOk(scored);
    expect(scored.stdout).toContain('none-1: stub-answer-served (2)');
    expect(scored.stdout).toMatch(/practice \(1 questions[\s\S]*correct_current\s+0\.00\s+1\.00\s+\+1\.00/);
    expect(scored.stdout).toMatch(/held_out \(1 questions[\s\S]*correct_current\s+0\.00\s+1\.00\s+\+1\.00/);

    const dry = await cli('score', 'none-1', 'cortex-1', '--dry-run');
    expect(dry.stdout).toContain('cortex-1: 2 of 2 cases answered, 2 judgements reusable, 0 to judge with stub-judge');

    const answerPrompts = prompts.filter((p) => p.startsWith('You are a coding agent'));
    expect(answerPrompts).toHaveLength(4);
    expect(answerPrompts.filter((p) => p.includes('CORTEX_MEMORY_START'))).toHaveLength(2);
    expect(prompts.some((p) => p.includes('ANSWER KEY'))).toBe(false);
  }, 120_000);
});
