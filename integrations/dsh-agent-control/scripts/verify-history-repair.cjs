const { test } = require('node:test');
const assert = require('node:assert/strict');
const { repair } = require('./repair-history-identities.cjs');
test('repair preserves all events and remaps duplicate turns and tool references idempotently', () => {
  const events = [1, 1].flatMap((turn, index) => [
    {type:'turn/start',seq:index*5,data:{turn}},
    {type:'assistant/message',seq:index*5+1,data:{turn,step:1,message:{content:[{type:'tool-call',id:'same'}]}}},
    {type:'tool/call',seq:index*5+2,data:{turn,callId:'same'}},
    {type:'tool/result',seq:index*5+3,data:{turn,message:{source:{callId:'same'},content:[{type:'tool-result',toolCallId:'same',content:[{type:'text',text:'output'}]}]}}},
    {type:'turn/end',seq:index*5+4,data:{turn}},
  ]);
  const fixed=repair(events);
  assert.equal(fixed.length,events.length);
  assert.equal(fixed[5].data.turn,2);
  assert.equal(fixed[7].data.callId,fixed[6].data.message.content[0].id);
  assert.equal(fixed[8].data.message.content[0].toolCallId,fixed[7].data.callId);
  assert.notEqual(fixed[7].data.callId,fixed[2].data.callId);
  assert.deepEqual(repair(fixed),fixed);
  assert.equal(events[5].data.turn,1);
});
