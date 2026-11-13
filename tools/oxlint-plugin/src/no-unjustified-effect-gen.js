import { isJustified } from './justification.js'

const messageId = 'unjustifiedEffectGen'

function isEffectGen(callee) {
  return (
    callee.type === 'MemberExpression' &&
    callee.computed === false &&
    callee.object.type === 'Identifier' &&
    callee.object.name === 'Effect' &&
    callee.property.type === 'Identifier' &&
    callee.property.name === 'gen'
  )
}

const noUnjustifiedEffectGen = {
  meta: {
    type: 'suggestion',
    messages: {
      [messageId]:
        'Write this effect as a pipe of combinators; keep `Effect.gen` only with a `// Why:` line saying what the pipe cannot express.',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (!isEffectGen(node.callee)) return
        if (isJustified(context.sourceCode, node)) return
        context.report({ messageId, node: node.callee })
      },
    }
  },
}

export default noUnjustifiedEffectGen
