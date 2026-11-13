import { effectModule, isCallTo } from './effect-ast.js'
import { isJustified } from './justification.js'

const effectAll = { moduleNames: effectModule, names: new Set(['all']) }
const effectService = { moduleNames: effectModule, names: new Set(['service']) }

function isServiceRead(property) {
  return (
    property.type === 'Property' &&
    property.kind === 'init' &&
    !property.method &&
    isCallTo(property.value, effectService) &&
    property.value.arguments.length === 1
  )
}

function gathersOnlyServices(node) {
  if (!isCallTo(node, effectAll) || node.arguments.length !== 1) return false
  const [record] = node.arguments
  return (
    record.type === 'ObjectExpression' &&
    record.properties.length > 0 &&
    record.properties.every(isServiceRead)
  )
}

const messageId = 'preferEffectServiceAll'

const preferEffectServiceAll = {
  meta: {
    type: 'suggestion',
    messages: {
      [messageId]:
        'Read several services with `EffectService.all({ key: Tag, … })` instead of an `Effect.all` of `Effect.service(Tag)` entries; keep it only with a `// Why:` line.',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (!gathersOnlyServices(node)) return
        if (isJustified(context.sourceCode, node)) return
        context.report({ messageId, node: node.callee })
      },
    }
  },
}

export default preferEffectServiceAll
