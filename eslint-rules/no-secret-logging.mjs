const sensitive = /^(secret|preimage)$/i;
const sink = /^(console|log|logger)$|Logger$/;
function containsSecret(node) {
  if (!node || typeof node !== 'object') return false;
  if (node.type === 'Identifier' && sensitive.test(node.name)) return true;
  if (
    node.type === 'Property' &&
    node.computed === false &&
    node.key?.type === 'Literal' &&
    sensitive.test(String(node.key.value))
  )
    return true;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent') continue;
    if (Array.isArray(value)) {
      if (value.some(containsSecret)) return true;
    } else if (value && typeof value === 'object' && containsSecret(value))
      return true;
  }
  return false;
}
function isSink(node) {
  if (node.type === 'Identifier') return sink.test(node.name);
  if (node.type === 'MemberExpression')
    return (
      isSink(node.object) ||
      (node.property.type === 'Identifier' && sink.test(node.property.name))
    );
  if (node.type === 'ChainExpression') return isSink(node.expression);
  if (node.type === 'CallExpression') return isSink(node.callee);
  return false;
}
/** Deliberate name-based guard, not data-flow taint analysis. Never alias secrets into log payloads. */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Reject secret/preimage identifiers in console and logger arguments',
    },
    schema: [],
    messages: { secret: 'Secret/preimage must never be logged (NFR-6).' },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (isSink(node.callee) && node.arguments.some(containsSecret))
          context.report({ node, messageId: 'secret' });
      },
    };
  },
};
