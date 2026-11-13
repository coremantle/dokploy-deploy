import {
  isClientEffectCall,
  isClientEffectCallback,
  isComposition,
  isEffectComposition,
  isFunction,
  isNamedFunction,
  isObjectLiteralMethod,
  isPipe,
} from './effect-ast.js'

const messageId = 'nestedEffectPipe'

// Why: a generator body is a sequence of statements, not a step of the pipe it is handed to, so each pipe inside it starts afresh; an atom's effect is its own unit even when the atom is piped afterwards.
function ownsItsPipes(node) {
  if (node.type === 'Program') return true
  if (isClientEffectCall(node)) return true
  if (!isFunction(node)) return false
  return (
    node.generator === true ||
    isNamedFunction(node) ||
    isObjectLiteralMethod(node) ||
    isClientEffectCallback(node)
  )
}

function headOf(composition) {
  const { callee } = composition
  if (isPipe(composition) && callee.type === 'MemberExpression') return callee
  return composition.arguments[0]
}

// Why: the head of a pipe or data-first call is the effect it starts from, not a step of it, so only a composition reached through a step — a callback or a step argument — is nested; the head of an Effect composition belongs to it, and that composition is checked on its own.
function isInsidePipe(node) {
  let child = node
  let current = node.parent
  while (current && !ownsItsPipes(current)) {
    if (isComposition(current)) {
      if (headOf(current) !== child) return true
      if (isEffectComposition(current)) return false
    }
    child = current
    current = current.parent
  }
  return false
}

const noNestedEffectPipe = {
  meta: {
    type: 'suggestion',
    messages: {
      [messageId]:
        'An Effect pipe is never nested in another pipe: extract this step into a method with its own span.',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (!isEffectComposition(node)) return
        if (!isInsidePipe(node)) return
        context.report({ node, messageId })
      },
    }
  },
}

export default noNestedEffectPipe
