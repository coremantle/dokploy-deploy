import {
  enclosingFunction,
  isClientEffectCall,
  isClientEffectCallback,
  isConstruction,
  isDataFirstComposition,
  isEffectPipe,
  isNamedFunction,
  isSpanCall,
  effectModule,
  moduleMemberName,
} from './effect-ast.js'
import { isJustifiedAbout } from './justification.js'

const messageId = 'missingTrailingSpan'
const errorMappings = new Set(['mapError', 'catchTag', 'catchTags'])
const effectErrorModule = new Set(['EffectError'])
const effectErrorMappings = new Set(['mapTag', 'mapTags'])

function endsWithSpan(pipeCall) {
  const lastStep = pipeCall.arguments.at(-1)
  return lastStep !== undefined && isSpanCall(lastStep)
}

function isErrorMapping(step) {
  return (
    step.type === 'CallExpression' &&
    (errorMappings.has(moduleMemberName(step.callee, effectModule)) ||
      effectErrorMappings.has(moduleMemberName(step.callee, effectErrorModule)))
  )
}

function pipeSteps(pipeCall) {
  if (pipeCall.callee.type === 'Identifier') return pipeCall.arguments.slice(1)
  return pipeCall.arguments
}

// Why: a wrapper that only translates errors does no work of its own, so a span there is trace noise (decision D1 of the functional-effect plan).
function onlyMapsErrors(pipeCall) {
  const steps = pipeSteps(pipeCall)
  return steps.length > 0 && steps.every(isErrorMapping)
}

function needsSpan(pipeCall) {
  if (isDataFirstComposition(pipeCall)) return true
  if (!isEffectPipe(pipeCall)) return false
  if (endsWithSpan(pipeCall)) return false
  return !onlyMapsErrors(pipeCall)
}

function ownsSpan(functionNode) {
  return isNamedFunction(functionNode) || isClientEffectCallback(functionNode)
}

const spanTopic = /span/iu

// Why: a span left out on purpose — a recursion whose every level would nest one span deeper — is stated by a `// Why:` about the span, above the return or its function; a `// Why:` on another subject exempts nothing.
function isJustifiedOmission(context, { returnedExpression, functionNode }) {
  return (
    isJustifiedAbout(context.sourceCode, {
      node: returnedExpression,
      topic: spanTopic,
    }) ||
    isJustifiedAbout(context.sourceCode, {
      node: functionNode,
      topic: spanTopic,
    })
  )
}

function reportUnspannedPipe(context, { returnedExpression, functionNode }) {
  if (!functionNode || !ownsSpan(functionNode)) return
  if (!needsSpan(returnedExpression)) return
  if (isConstruction(returnedExpression)) return
  if (isJustifiedOmission(context, { returnedExpression, functionNode })) return
  context.report({ messageId, node: returnedExpression })
}

const effectPipeEndsWithSpan = {
  meta: {
    type: 'suggestion',
    messages: {
      [messageId]:
        "A function returning an Effect pipe ends it with `Effect.withSpan('<Component>.<operation>')`.",
    },
  },
  create(context) {
    return {
      ReturnStatement(node) {
        if (!node.argument) return
        reportUnspannedPipe(context, {
          returnedExpression: node.argument,
          functionNode: enclosingFunction(node),
        })
      },
      ArrowFunctionExpression(node) {
        if (node.body.type === 'BlockStatement') return
        reportUnspannedPipe(context, {
          returnedExpression: node.body,
          functionNode: node,
        })
      },
      CallExpression(node) {
        if (!isClientEffectCall(node)) return
        for (const argument of node.arguments.filter(needsSpan)) {
          context.report({ messageId, node: argument })
        }
      },
    }
  },
}

export default effectPipeEndsWithSpan
