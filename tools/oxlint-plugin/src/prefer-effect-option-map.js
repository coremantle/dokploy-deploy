import { dualCallback, effectModule, isCallTo } from './effect-ast.js'
import { isJustified } from './justification.js'

const effectMap = { moduleNames: effectModule, names: new Set(['map']) }
const optionMap = {
  moduleNames: new Set(['Option']),
  names: new Set(['map']),
}

function mapsTheOption(node) {
  if (!isCallTo(node, effectMap)) return false
  const callback = dualCallback(node)
  return isCallTo(callback, optionMap) && callback.arguments.length === 1
}

const messageId = 'preferEffectOptionMap'

const preferEffectOptionMap = {
  meta: {
    type: 'suggestion',
    messages: {
      [messageId]:
        'Reshape the found value with `EffectOption.map(f)` instead of `Effect.map(Option.map(f))`; keep it only with a `// Why:` line.',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (!mapsTheOption(node)) return
        if (isJustified(context.sourceCode, node)) return
        context.report({ messageId, node: node.callee })
      },
    }
  },
}

export default preferEffectOptionMap
