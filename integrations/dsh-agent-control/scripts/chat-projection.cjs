// Exercise the installed Chat reducer, not a substitute that merely lists log rows.
const fs = require('node:fs');

function loadChatProjection(bundle) {
  const source = fs.readFileSync(bundle, 'utf8');
  if (!source.includes('const assistantDefinition =') || !source.includes('return module.exports;')) {
    throw new Error('Unsupported DSH Chat bundle: assistant projection unavailable');
  }
  let definition;
  const instrumented = source.replace('return module.exports;', 'module.exports.probeAssistant = assistantDefinition; return module.exports;');
  new Function('window', instrumented)({ __ModuleLoader__: { load: ({ factory }) => {
    definition = factory(id => id.startsWith('react') ? require(id) : {}).probeAssistant;
  } } });
  return events => {
    const contexts = new Map();
    for (const event of events) {
      const match = definition.match(event);
      if (!match) continue;
      const context = contexts.get(match.id) ?? { matches: [] };
      const entry = { event };
      context.matches.push(entry);
      if (match.role === 'start') {
        context.start = entry;
        context.state = definition.start(context, entry);
      } else context.state = definition.update(context, entry);
      contexts.set(match.id, context);
    }
    const messages = [...contexts.values()].filter(context => context.state?.final).map(context => {
      const data = definition.buildLocationData(context, 'step').value;
      return { seq: data.finalNode.seq, blocks: data.blocks };
    });
    return messages.sort((a, b) => a.seq - b.seq);
  };
}
module.exports = { loadChatProjection };
