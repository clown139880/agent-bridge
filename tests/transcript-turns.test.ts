import assert from 'node:assert/strict';
import test from 'node:test';
import { projectEntry, type ViewItem, type WireEvent } from '../packages/transcript/src/index.js';

const event = (seq: number, type: string, payload: Record<string, unknown> = {}, turnId: string | null = 'one', itemId?: string) =>
  ({ seq, eventId: String(seq), cursor: `e:${seq}`, sessionId: 'session', type, payload, turnId, itemId, timestamp: seq * 1000 }) as WireEvent & { seq: number };
const entry = (events: Array<WireEvent & { seq: number }>, superseded = false) => projectEntry({ key: 't:one', events, superseded });

async function render(view: ReturnType<typeof entry>, options: { mode?: 'standard' | 'verbose'; session?: Record<string, unknown> } = {}) {
  const { createElement, renderToStaticMarkup } = await import('../apps/control-center/test/render.js');
  const { TurnView } = await import('../apps/control-center/src/turn-view.js');
  const paint = (item: ViewItem) => createElement('p', {}, String(item.event.payload.text ?? item.event.payload.output ?? item.event.type));
  return renderToStaticMarkup(createElement(TurnView, { entry: view, mode: options.mode ?? 'standard', session: options.session as never, render: paint }));
}

test('settled work folds but prompts and answers remain visible; failed work stays open', async () => {
  const view = entry([event(1, 'turn.started'), event(2, 'message.completed', { role: 'user', text: 'prompt' }),
    event(3, 'tool.completed', { output: 'private tool output' }, 'one', 'x'), event(4, 'message.completed', { role: 'assistant', text: 'answer' }), event(5, 'turn.completed')]);
  const html = await render(view);
  assert.match(html, /prompt/); assert.match(html, /answer/); assert.doesNotMatch(html, /private tool output/); assert.match(html, /aria-expanded="false"/);
  assert.match(html, /已完成/);
  const failed = await render({ ...view, status: 'failed' });
  assert.match(failed, /private tool output/); assert.match(failed, /aria-expanded="true"/);
});

test('a started turn is running only while the session says so', async () => {
  const view = entry([event(1, 'turn.started'), event(2, 'message.completed', { role: 'user', text: 'q' }), event(3, 'tool.completed', {}, 'one', 'x')]);
  assert.match(await render(view, { session: { activeTurnId: 'one', status: 'active' } }), /正在执行/);
  const idle = await render(view, { session: { activeTurnId: null, status: 'idle' } });
  assert.doesNotMatch(idle, /正在执行/); assert.match(idle, /执行记录/);
});

test('output after a terminal event is shown as continued activity', async () => {
  const view = entry([event(1, 'turn.started'), event(2, 'turn.completed'), event(3, 'command.completed', { output: 'late' }, 'one', 'y')]);
  assert.match(await render(view), /之后仍有活动/);
});

test('a steering prompt splits the turn in place, each part with its own answer', async () => {
  const view = entry([event(1, 'message.completed', { role: 'user', text: 'first' }), event(2, 'tool.completed', {}, 'one', 'x'),
    event(3, 'message.completed', { role: 'user', text: 'steer' }), event(4, 'message.completed', { role: 'assistant', text: 'done' }), event(5, 'turn.interrupted')]);
  const html = await render(view);
  assert.equal(html.match(/execution-turn/g)?.length, 2);
  assert.ok(html.indexOf('first') < html.indexOf('steer') && html.indexOf('steer') < html.indexOf('done'));
  assert.match(html, /已中断/);
});
