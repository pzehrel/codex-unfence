const requiredPreload = {
  'tests/fixtures/npx-final-bin.cjs': './managed-boundaries.cjs',
  'tests/fixtures/managed-boundaries.cjs': './transaction-boundaries.cjs',
};

export default {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      missing: '{{file}} must unconditionally require {{boundary}} at top level before dependent boundary wrapping.',
    },
  },
  create(context) {
    const file = Object.keys(requiredPreload).find(file => context.filename.endsWith(`/${file}`));
    if (!file) return {};
    const boundary = requiredPreload[file];
    let wrappingStart = Infinity;
    return {
      // Saving a boundary API before its preload also captures the unwrapped original.
      MemberExpression(node) {
        if (node.object.type === 'Identifier' && ['childProcess', 'promises'].includes(node.object.name)) {
          wrappingStart = Math.min(wrappingStart, node.range[0]);
        }
      },
      AssignmentExpression(node) {
        const target = node.left;
        if (target.type === 'MemberExpression' && target.object.type === 'Identifier' && target.object.name === 'os'
          && (target.computed ? target.property.value : target.property.name) === 'userInfo') {
          wrappingStart = Math.min(wrappingStart, node.range[0]);
        }
      },
      'Program:exit'(node) {
        const loaded = node.body.some(statement => {
          const call = statement.type === 'ExpressionStatement' ? statement.expression : null;
          return call?.type === 'CallExpression' && call.callee.type === 'Identifier'
            && call.callee.name === 'require' && call.arguments.length === 1
            && call.arguments[0].type === 'Literal' && call.arguments[0].value === boundary
            && call.range[0] < wrappingStart;
        });
        if (!loaded) context.report({ node, messageId: 'missing', data: { file, boundary } });
      },
    };
  },
};
