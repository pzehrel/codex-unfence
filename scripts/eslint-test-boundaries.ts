import type { TSESLint } from '@typescript-eslint/utils';

const requiredPreload: Record<string, string> = {
  'tests/fixtures/npx-final-bin.cts': './managed-boundaries.cjs',
  'tests/fixtures/managed-boundaries.cts': './transaction-boundaries.cjs',
};

const rule: TSESLint.RuleModule<'missing'> = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      missing: '{{file}} must unconditionally require {{boundary}} at top level before dependent boundary wrapping.',
    },
  },
  defaultOptions: [],
  create(context) {
    const file = Object.keys(requiredPreload).find(file => context.filename.endsWith(`/${file}`));
    if (!file) return {};
    const boundary = requiredPreload[file];
    if (!boundary) throw new Error(`Missing boundary contract for ${file}`);
    let wrappingStart = Infinity;
    return {
      // Saving a boundary API before its preload also captures the unwrapped original.
      MemberExpression(node) {
        if (node.object.type === 'Identifier' && ['childProcess', 'promises'].includes(node.object.name)) {
          wrappingStart = Math.min(wrappingStart, node.range[0]);
        }
      },
      ObjectPattern(node) {
        const parent = node.parent;
        const source = parent.type === 'VariableDeclarator' ? parent.init
          : parent.type === 'AssignmentExpression' ? parent.right : null;
        if (source?.type === 'Identifier' && ['childProcess', 'promises'].includes(source.name)) {
          wrappingStart = Math.min(wrappingStart, node.range[0]);
        }
      },
      AssignmentExpression(node) {
        const target = node.left;
        if (target.type === 'MemberExpression' && target.object.type === 'Identifier' && target.object.name === 'os') {
          const property = !target.computed && target.property.type === 'Identifier' ? target.property.name
            : target.property.type === 'TemplateLiteral' && target.property.expressions.length === 0
              ? target.property.quasis[0]?.value.cooked : target.property.type === 'Literal' ? target.property.value : undefined;
          if (property === 'userInfo') wrappingStart = Math.min(wrappingStart, node.range[0]);
        }
      },
      'Program:exit'(node) {
        const loaded = node.body.some(statement => {
          const call = statement.type === 'ExpressionStatement' ? statement.expression : null;
          const argument = call?.type === 'CallExpression' ? call.arguments[0] : undefined;
          return call?.type === 'CallExpression' && !call.optional && call.callee.type === 'Identifier'
            && call.callee.name === 'require' && call.arguments.length === 1
            && argument?.type === 'Literal' && argument.value === boundary
            && call.range[0] < wrappingStart;
        });
        if (!loaded) context.report({ node, messageId: 'missing', data: { file, boundary } });
      },
    };
  },
};
export default rule;
