import {
  dualCallback,
  effectModule,
  isCallTo,
  methodCallName,
} from './effect-ast.js'
import { forwardingLambda, isForwardableFunction } from './forwarding-lambda.js'
import { isJustified } from './justification.js'

const effectMap = { moduleNames: effectModule, names: new Set(['map']) }
const arrayMethods = new Set(['map', 'filter'])

function forwardedArrayMethod(sourceCode, node) {
  if (!isCallTo(node, effectMap)) return null
  const forwarding = forwardingLambda(sourceCode, dualCallback(node))
  if (forwarding === null) return null
  const { returned, parameterRead } = forwarding
  if (returned.type !== 'CallExpression') return null
  const methodName = methodCallName(returned)
  const forwardsItsParameter =
    arrayMethods.has(methodName) &&
    returned.callee.object === parameterRead &&
    returned.arguments.length === 1 &&
    isForwardableFunction(returned.arguments[0])
  return forwardsItsParameter ? methodName : null
}

const messageId = 'preferDataLastArrayMethod'

const preferDataLastArrayMethod = {
  meta: {
    type: 'suggestion',
    messages: {
      [messageId]:
        'This lambda only calls `.{{methodName}}` on the previous result: pass the data-last form, `Effect.map(Array.{{methodName}}(f))`; keep it only with a `// Why:` line.',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const methodName = forwardedArrayMethod(context.sourceCode, node)
        if (methodName === null) return
        if (isJustified(context.sourceCode, node)) return
        context.report({ messageId, node: node.callee, data: { methodName } })
      },
    }
  },
}

export default preferDataLastArrayMethod
