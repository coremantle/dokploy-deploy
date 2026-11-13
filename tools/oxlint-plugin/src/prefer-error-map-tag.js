import {
  effectModule,
  isCallTo,
  moduleMemberName,
  returnedExpression,
} from './effect-ast.js'
import { isJustified } from './justification.js'

const effectFail = { moduleNames: effectModule, names: new Set(['fail']) }

function onlyFails(handler) {
  const returned = returnedExpression(handler)
  return isCallTo(returned, effectFail) && returned.arguments.length === 1
}

function isTagLiteral(node) {
  return (
    (node.type === 'Literal' && typeof node.value === 'string') ||
    node.type === 'TemplateLiteral' ||
    node.type === 'ArrayExpression'
  )
}

// Why: `catchTag(tag, f)` and `catchTag(self, tag, f)` both end with the handler, but so does `catchTag(tag, f, orElse)`, which `mapTag` has no counterpart for — three arguments are read as data-first only when the tag is spelled out second.
function catchTagHandler({ arguments: callArguments }) {
  if (callArguments.length === 2) return callArguments[1]
  const isDataFirst =
    callArguments.length === 3 &&
    !isTagLiteral(callArguments[0]) &&
    isTagLiteral(callArguments[1])
  return isDataFirst ? callArguments[2] : null
}

// Why: the cases record comes first in the pipeable form and second in the data-first one; anything after it is an `orElse`, which `mapTags` has no counterpart for.
function catchTagsCases({ arguments: callArguments }) {
  const casesIndex = callArguments.findIndex(
    ({ type }) => type === 'ObjectExpression',
  )
  const isLastOfAtMostTwo =
    casesIndex !== -1 &&
    casesIndex <= 1 &&
    casesIndex === callArguments.length - 1
  return isLastOfAtMostTwo ? callArguments[casesIndex] : null
}

function onlyFailingCases({ properties }) {
  return (
    properties.length > 0 &&
    properties.every(
      (property) => property.type === 'Property' && onlyFails(property.value),
    )
  )
}

function isRefailingCatch(node) {
  const combinatorName = moduleMemberName(node.callee, effectModule)
  if (combinatorName === 'catchTag') {
    const handler = catchTagHandler(node)
    return handler !== null && onlyFails(handler)
  }
  if (combinatorName === 'catchTags') {
    const cases = catchTagsCases(node)
    return cases !== null && onlyFailingCases(cases)
  }
  return false
}

const messageId = 'preferErrorMapTag'

const preferErrorMapTag = {
  meta: {
    type: 'suggestion',
    messages: {
      [messageId]:
        'This handler only replaces one failure with another: use `EffectError.mapTag(tag, (error) => newError)` / `EffectError.mapTags({ … })` instead of `Effect.catchTag` / `catchTags` returning `Effect.fail`; keep it only with a `// Why:` line.',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (!isRefailingCatch(node)) return
        if (isJustified(context.sourceCode, node)) return
        context.report({ messageId, node: node.callee })
      },
    }
  },
}

export default preferErrorMapTag
