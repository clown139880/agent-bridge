import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { readFileSync } from 'node:fs';
import { ClaudeCodeAdapter } from '../apps/bridge/src/claude/claude-adapter.js';
import { taskKind, toolSummary } from '../apps/bridge/src/claude/activity.js';
import type { BridgeToControlMessage, StructuredSessionEventMessage } from '../packages/protocol/src/index.js';

const PROBE = readFileSync(new URL('./fixtures/claude-tasks-stream.jsonl', import.meta.url), 'utf8')
  .split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
const EXPLORE_CALL = 'toolu_01Nk1WX5YK2xbZyTbcU8FHjJ';
const BACKGROUND_AGENT_CALL = 'toolu_012hLYzUxLbR5Swr5ZVBKq5c';
const BACKGROUND_BASH_CALL = 'toolu_013xDGfDpfwtL9U77FtRJQNK';

function fixture() {
  const events: BridgeToControlMessage[] = [];
  const adapter = new ClaudeCodeAdapter({command:'',allowedRoots:[]}, event => events.push(event));
  const seam = adapter as unknown as {
    handleMessage(session: unknown, message: unknown): void;
    consume(session: unknown): Promise<void>;
    sessions: Map<string, unknown>;
  };
  const session: Record<string, unknown> & { tasks: Map<string, unknown> } = {sessionId:'claude-public',cwd:'/work',projectPath:'/work',
    discovered:true,turnSeq:0,logs:[],toolUses:new Map(),tasks:new Map(),pendingApprovals:new Map(),ended:false};
  const structured = () => events.flatMap(event => event.type === 'session.event' ? [event] : []);
  const ofType = (type: string) => structured().filter(event => event.eventType === type);
  return { seam, session, structured, ofType };
}

function started(taskId: string, toolUseId: string, taskType = 'local_agent') {
  return {type:'system',subtype:'task_started',task_id:taskId,tool_use_id:toolUseId,description:'Explore the repo',
    subagent_type:'Explore',is_backgrounded:true,task_type:taskType};
}

test('a replayed Claude probe keeps subagent work out of the main conversation and reports every task', () => {
  const { seam, session, structured, ofType } = fixture();
  for (const message of PROBE) seam.handleMessage(session, message);

  const replies = ofType('message.completed').map(event => String(event.payload.text));
  assert.ok(replies.includes('Both background tasks finished.\n\nALL DONE'));
  assert.ok(!replies.some(text => text.includes('printed four files')), 'a subagent reply is not a main-thread message');

  const tasks = ofType('task.started');
  assert.deepEqual(tasks.map(event => [event.itemId, event.payload.kind, event.payload.background]), [
    [BACKGROUND_BASH_CALL, 'bash', true], [EXPLORE_CALL, 'agent', false], [BACKGROUND_AGENT_CALL, 'agent', true],
  ]);
  const completed = ofType('task.completed');
  assert.deepEqual(completed.map(event => [event.itemId, event.payload.status]).sort(), [
    [BACKGROUND_AGENT_CALL, 'completed'], [BACKGROUND_BASH_CALL, 'completed'], [EXPLORE_CALL, 'completed'],
  ]);
  const explore = completed.find(event => event.itemId === EXPLORE_CALL)!;
  assert.match(String(explore.payload.summary), /alpha/);
  assert.equal(explore.payload.subagentType, 'Explore');
  assert.equal(session.tasks.size, 0);

  // A subagent's tool calls are steps of the call that spawned it.
  const read = ofType('tool.started').find(event => event.payload.name === 'Read');
  assert.equal(read?.payload.parentItemId, EXPLORE_CALL);
  const listing = ofType('command.completed').find(event => event.payload.command === 'ls -la /tmp/probe');
  assert.equal(listing?.payload.parentItemId, EXPLORE_CALL);
  assert.equal(listing?.itemId, 'toolu_01Lmwu721f9HGmnAPKqc4okL');
  const mainBash = ofType('command.completed').find(event => event.payload.command === 'true');
  assert.equal(mainBash?.payload.parentItemId, undefined);

  // The spawning calls themselves surface only as tasks.
  assert.ok(!structured().some(event => event.eventType.startsWith('tool.') && event.payload.name === 'Agent'));
  // Two progress reports of the Explore agent arrived two seconds apart; only the first is stored.
  assert.equal(ofType('task.progress').filter(event => event.itemId === EXPLORE_CALL).length, 1);
  // Phases mark switches only: thinking once, then writing at each new reply.
  const phases = ofType('progress').map(event => event.payload.phase);
  assert.equal(phases[0], 'thinking');
  assert.ok(phases.includes('writing'));
});

test('a Claude task reports its latest progress at most once per interval', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const { seam, session, ofType } = fixture();
    seam.handleMessage(session, started('t1', 'call-1'));
    const progress = (description: string, toolUses: number) => seam.handleMessage(session, {type:'system',subtype:'task_progress',
      task_id:'t1',description,usage:{tool_uses:toolUses,total_tokens:100},last_tool_name:'Grep'});
    progress('Reading a.ts', 1);
    progress('Reading b.ts', 2);
    progress('Searching', 3);
    assert.equal(ofType('task.progress').length, 1);
    mock.timers.tick(10_000);
    const reports = ofType('task.progress');
    assert.deepEqual(reports.map(event => event.payload.description), ['Reading a.ts', 'Searching']);
    assert.deepEqual(reports[1]?.payload, {taskId:'t1',description:'Searching',toolUses:3,totalTokens:100,lastToolName:'Grep'});
  } finally { mock.timers.reset(); }
});

test('a Claude task marked finished without a notification is closed after a grace period, once', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const { seam, session, ofType } = fixture();
    seam.handleMessage(session, started('t1', 'call-1', 'local_bash'));
    seam.handleMessage(session, {type:'system',subtype:'task_updated',task_id:'t1',patch:{status:'killed'}});
    assert.equal(ofType('task.completed').length, 0);
    mock.timers.tick(3_000);
    seam.handleMessage(session, {type:'system',subtype:'task_notification',task_id:'t1',status:'killed',summary:'late'});
    assert.deepEqual(ofType('task.completed').map(event => event.payload.status), ['killed']);
    assert.equal(session.tasks.size, 0);
  } finally { mock.timers.reset(); }
});

test('Claude tasks still open when the subprocess exits are reported lost', async () => {
  const { seam, session, ofType } = fixture();
  session.query = (async function* () { yield started('t1', 'call-1'); })();
  seam.sessions.set('claude-public', session);
  await seam.consume(session);
  const lost = ofType('task.completed');
  assert.equal(lost.length, 1);
  assert.equal(lost[0]?.payload.status, 'lost');
  assert.equal(lost[0]?.itemId, 'call-1');
});

test('Claude tool calls other than commands and edits report their start and end', () => {
  const { seam, session, ofType } = fixture();
  seam.handleMessage(session, {type:'assistant',message:{content:[{type:'tool_use',id:'g1',name:'Grep',input:{pattern:'TODO',path:'/work/src'}}]}});
  seam.handleMessage(session, {type:'user',message:{role:'user',content:[{type:'tool_result',tool_use_id:'g1',content:'src/a.ts:1: TODO'}]}});
  const [start] = ofType('tool.started') as StructuredSessionEventMessage[];
  assert.equal(start?.itemId, 'g1');
  assert.deepEqual(start?.payload, {name:'Grep',summary:'Grep "TODO" in src'});
  const [end] = ofType('tool.completed');
  assert.deepEqual(end?.payload, {name:'Grep',summary:'Grep "TODO" in src',status:'completed',output:'src/a.ts:1: TODO'});
  assert.equal(end?.turnId, start?.turnId);
});

test('Claude tool summaries and task kinds read like the work they describe', () => {
  assert.equal(toolSummary('Bash', {command:'pnpm test\nsecond line'}), '$ pnpm test');
  assert.equal(toolSummary('Read', {file_path:'/work/src/index.ts'}), 'Read index.ts');
  assert.equal(toolSummary('WebSearch', {query:'node test mock timers'}), 'WebSearch "node test mock timers"');
  assert.equal(toolSummary('mcp__memory__search', {query:'deploy'}), 'mcp__memory__search deploy');
  assert.equal(toolSummary('TodoWrite', {}), 'TodoWrite');
  assert.equal(taskKind('local_agent'), 'agent');
  assert.equal(taskKind('local_bash'), 'bash');
  assert.equal(taskKind('local_bash', 'Monitor'), 'monitor');
  assert.equal(taskKind('something_new'), 'other');
});
