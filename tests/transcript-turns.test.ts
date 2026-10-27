import assert from 'node:assert/strict';
import test from 'node:test';
import { transcriptRows, transcriptTurns, turnPresentation } from '../apps/control-center/src/transcript.js';
import type { SessionEvent } from '../apps/control-center/src/api/types.js';
const event = (id: string, type: string, payload: Record<string, unknown> = {}, turnId: string | null = 'one', itemId?: string): SessionEvent =>
  ({ eventId: id, cursor: id, sessionId: 'session', type, payload, turnId, itemId, timestamp: Number(id) * 1000 });

test('one remote turn retains tools and commentary in order with one final reply', () => {
  const rows = [event('1','turn.started'), event('2','message.completed',{role:'user',text:'hello'}),
    event('3','message.completed',{role:'assistant',text:'checking'}), event('4','tool.started',{},'one','call'),
    event('5','command.completed',{output:'result'},'one','call'), event('6','message.completed',{role:'assistant',text:'done'}), event('7','turn.completed')];
  const [turn] = transcriptTurns(rows);
  assert.equal(transcriptTurns(rows).length, 1); assert.equal(turn.status,'completed'); assert.equal(turn.durationMs,6000);
  const view = turnPresentation(turn);
  assert.deepEqual(view.prompts.map(r=>r.event.payload.text),['hello']);
  assert.deepEqual(view.process.map(r=>r.event.eventId),['3','5']); assert.equal(view.final?.event.payload.text,'done');
});
test('reused tool ids from different turns never overwrite one another', () => {
  const rows=transcriptRows([event('1','tool.started',{},'one','call'),event('2','tool.completed',{},'one','call'),event('3','tool.completed',{},'two','call')]);
  assert.deepEqual(rows.map(r=>r.event.eventId),['2','3']);
});
test('partial pages never invent a start time or completed status', () => {
  const [turn]=transcriptTurns([event('3','tool.completed'),event('4','message.completed',{role:'assistant',text:'answer'})]);
  assert.equal(turn.partial,true);assert.equal(turn.status,'unknown');assert.equal(turn.durationMs,undefined);
});
test('steered prompts stay between their surrounding output rather than moving to the beginning', () => {
  const turns=transcriptTurns([event('1','turn.started'),event('2','message.completed',{role:'user',text:'first'}),event('3','tool.completed'),event('4','message.completed',{role:'user',text:'steer'}),event('5','turn.interrupted')]);
  assert.equal(turns.length,2);assert.equal(turns[1].status,'interrupted');
  assert.deepEqual(turns.flatMap(t=>t.rows).map(r=>r.event.eventId),['1','2','3','4','5']);
});
test('commentary followed by work is not promoted to a final answer', () => {
  const [turn]=transcriptTurns([event('1','message.completed',{role:'assistant',text:'working'}),event('2','tool.started')]);
  assert.equal(turnPresentation(turn).final,undefined);
});
test('settled work folds but prompts and answers remain visible; failed work stays open', async () => {
  const {createElement,renderToStaticMarkup}=await import('../apps/control-center/test/render.js');
  const {TurnView}=await import('../apps/control-center/src/turn-view.js');
  const [turn]=transcriptTurns([event('1','turn.started'),event('2','message.completed',{role:'user',text:'prompt'}),event('3','tool.completed',{output:'private tool output'}),event('4','message.completed',{role:'assistant',text:'answer'}),event('5','turn.completed')]);
  const render=(e:SessionEvent)=>createElement('p',{},String(e.payload.text??e.payload.output??e.type));
  const html=renderToStaticMarkup(createElement(TurnView,{turn,mode:'standard',render}));
  assert.match(html,/prompt/);assert.match(html,/answer/);assert.doesNotMatch(html,/private tool output/);assert.match(html,/aria-expanded="false"/);
  const failed=renderToStaticMarkup(createElement(TurnView,{turn:{...turn,status:'failed'},mode:'standard',render}));
  assert.match(failed,/private tool output/);assert.match(failed,/aria-expanded="true"/);
});
