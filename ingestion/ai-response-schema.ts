// JSON Schema for the model reply (an array of per-post results), kept in sync with ai-schema.ts.
// Providers that support constrained decoding (Gemini `responseSchema`) use it so the reply is
// structurally valid by construction; our own validator still checks every reply regardless.
const str = { type: ['string', 'null'] };
const num = { type: ['number', 'null'] };

const evidenceOnly = (props: Record<string, unknown>) => ({
  type: 'object',
  properties: props,
  required: Object.keys(props),
});

const event = {
  type: ['object', 'null'],
  properties: {
    officialTitle: str,
    displayLabel: str,
    artists: {
      type: 'array',
      items: evidenceOnly({ name: { type: 'string' }, evidence: str }),
    },
    category: { type: ['string', 'null'], enum: ['concert', 'nightlife', 'festival', 'other', null] },
    date: evidenceOnly({ value: str, endValue: str, evidence: str }),
    startTime: evidenceOnly({ value: str, evidence: str }),
    venue: evidenceOnly({ name: str, areaClue: str, evidence: str }),
    ticket: evidenceOnly({ url: str, minPhp: num, maxPhp: num, isFree: { type: ['boolean', 'null'] }, evidence: str }),
  },
  required: ['officialTitle', 'displayLabel', 'artists', 'category', 'date', 'startTime', 'venue', 'ticket'],
};

export type JsonSchema = Record<string, unknown>;

export const AI_JSON_SCHEMA: JsonSchema = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      classification: { type: 'string', enum: ['upcoming_event', 'past_event_recap', 'unrelated', 'ambiguous'] },
      update: { type: 'string', enum: ['none', 'cancelled', 'postponed', 'rescheduled', 'updated'] },
      event,
      notes: { type: 'array', items: { type: 'string' } },
    },
    required: ['id', 'classification', 'update', 'event', 'notes'],
  },
};
