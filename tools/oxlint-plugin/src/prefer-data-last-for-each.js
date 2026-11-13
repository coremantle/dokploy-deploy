import { dualCallback, effectModule, isCallTo } from './effect-ast.js'
import { forwardingLambda, isForwardableFunction } from './forwarding-lambda.js'
import { isJustified } from './justification.js'

const sequencingCombinators = {
  moduleNames: effectModule,
  names: new Set(['flatMap', 'andThen', 'tap']),
}
const effectForEach = { moduleNames: effectModule, names: new Set(['forEach']) }

function forwardsToForEach(sourceCode, node) {
  if (!isCallTo(node, sequencingCombinators)) return false
  const forwarding = forwardingLambda(sourceCode, dualCallback(node))
  if (forwarding === null) return false
  const { returned, parameterRead } = forwarding
  if (!isCallTo(returned, effectForEach)) return false
  const [items, iteratee] = returned.arguments
  return items === parameterRead && isForwardableFunction(iteratee)
}

const messageId = 'preferDataLastForEach'

const preferDataLastForEach = {
  meta: {
    type: 'suggestion',
    messages: {
      [messageId]:
        'This lambda only forwards the previous result to `Effect.forEach`: pass the data-last form, `Effect.{{combinator}}(Effect.forEach(f, …))`; keep it only with a `// Why:` line.',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (!forwardsToForEach(context.sourceCode, node)) return
        if (isJustified(context.sourceCode, node)) return
        context.report({
          messageId,
          node: node.callee,
          data: { combinator: node.callee.property.name },
        })
      },
    }
  },
}

export default preferDataLastForEach
