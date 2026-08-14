/**
 * Provider-facing schema only. It deliberately describes the external envelope
 * (without the internal parser-generated id); ActionParser remains the final
 * local authority before anything reaches a dispatcher.
 */
const reason = { type: 'string', minLength: 1, maxLength: 500 } as const;

function envelope(type: string, properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: { type: { const: type }, reason, ...properties },
    required: ['type', 'reason', ...required],
  };
}

export const actionEnvelopeJsonSchema = {
  oneOf: [
    envelope('list_files', { path: { type: 'string', minLength: 1 } }, []),
    envelope('read_file', { path: { type: 'string', minLength: 1 } }, ['path']),
    envelope('write_file', { path: { type: 'string', minLength: 1 }, content: { type: 'string' } }, ['path', 'content']),
    envelope('run_command', {
      command: { type: 'string', minLength: 1 },
      args: { type: 'array', items: { type: 'string', minLength: 1 } },
    }, ['command', 'args']),
    envelope('run_tests', {}, []),
    envelope('remember', { note: { type: 'string', minLength: 1, maxLength: 300 } }, ['note']),
    envelope('finish', { summary: { type: 'string', minLength: 1, maxLength: 1000 } }, ['summary']),
  ],
} as const;
