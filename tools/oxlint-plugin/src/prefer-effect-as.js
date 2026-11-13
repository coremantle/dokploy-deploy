import {
  dualCallback,
  effectModule,
  isCallTo,
  methodCallName,
  returnedExpression,
} from './effect-ast.js'
import { isJustified } from './justification.js'

const effectMap = { moduleNames: effectModule, names: new Set(['map']) }

function isFactoryCall(node) {
  return (
    methodCallName(node) === 'make' &&
    isPureValue(node.callee.object) &&
    node.arguments.every(isPureValue)
  )
}

function isPureProperty(property) {
  if (property.type === 'SpreadElement') return isPureValue(property.argument)
  return (
    property.kind === 'init' &&
    !property.method &&
    (!property.computed || isPureValue(property.key)) &&
    isPureValue(property.value)
  )
}

// Why: `Effect.as` evaluates its value when the pipe is built, so only reads of what is already in scope and `X.make(…)` factories qualify — any other call could run a helper that a guard was meant to skip; a regular expression keeps a `lastIndex` that runs would share.
function isPureValue(node) {
  if (node === null) return true
  switch (node.type) {
    case 'Identifier':
    case 'ThisExpression':
      return true
    case 'Literal':
      return node.regex === undefined
    case 'TemplateLiteral':
      return node.expressions.every(isPureValue)
    case 'MemberExpression':
      return (
        !node.optional &&
        isPureValue(node.object) &&
        (!node.computed || isPureValue(node.property))
      )
    case 'SpreadElement':
      return isPureValue(node.argument)
    case 'ArrayExpression':
      return node.elements.every(isPureValue)
    case 'ObjectExpression':
      return node.properties.every(isPureProperty)
    case 'CallExpression':
      return isFactoryCall(node)
    default:
      return false
  }
}

const literalTypes = new Set(['ArrayExpression', 'ObjectExpression'])

function mapsToAPureLiteral(node) {
  if (!isCallTo(node, effectMap)) return false
  const callback = dualCallback(node)
  const isPlainArrow =
    callback?.type === 'ArrowFunctionExpression' &&
    !callback.async &&
    callback.params.length === 0
  if (!isPlainArrow) return false
  const returned = returnedExpression(callback)
  return literalTypes.has(returned?.type) && isPureValue(returned)
}

const messageId = 'preferEffectAs'

const preferEffectAs = {
  meta: {
    type: 'suggestion',
    messages: {
      [messageId]:
        'This callback ignores the result and returns a value already at hand: use `Effect.as(value)` instead of `Effect.map(() => value)`; keep it only with a `// Why:` line.',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (!mapsToAPureLiteral(node)) return
        if (isJustified(context.sourceCode, node)) return
        context.report({ messageId, node: node.callee })
      },
    }
  },
}

export default preferEffectAs
