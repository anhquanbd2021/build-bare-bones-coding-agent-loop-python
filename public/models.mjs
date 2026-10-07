// models.mjs — swappable "providers". Both wrap the same playback deck;
// the loop sees one contract: async (messages, ctx) => {text|toolCalls}.
// That single seam is the whole point of a provider adapter.

export function scriptedModel(deck, { style = 'terse' } = {}) {
  let cursor = 0;
  return async () => {
    const stepOut = deck[cursor] ?? {
      text: '(deck exhausted — a playback model has nothing left to say; ending the turn)',
    };
    cursor += 1;
    if (stepOut.text !== undefined && style === 'verbose') {
      return { text: `Here is my summary of the run so far: ${stepOut.text}` };
    }
    return stepOut;
  };
}

export const PROVIDERS = [
  { id: 'deck-terse', label: 'deck-terse (sim)', style: 'terse',
    blurb: 'Returns the deck verbatim — the stand-in for a minimal model.' },
  { id: 'deck-verbose', label: 'deck-verbose (sim)', style: 'verbose',
    blurb: 'Same tool calls, different voice — the stand-in for a chatty model.' },
];

export function makeProvider(id, deck) {
  const provider = PROVIDERS.find((p) => p.id === id);
  if (!provider) throw new Error(`unknown provider: '${id}' — pick one of ${PROVIDERS.map((p) => p.id).join(', ')}`);
  return scriptedModel(deck, { style: provider.style });
}
