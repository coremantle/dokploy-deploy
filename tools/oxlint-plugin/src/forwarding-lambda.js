import { isFunction, returnedExpression } from './effect-ast.js'

function soleIdentifierParameter(callback) {
  if (!isFunction(callback) || callback.params.length !== 1) return null
  const [parameter] = callback.params
  return parameter.type === 'Identifier' ? parameter : null
}

function referencesOf(sourceCode, { callback, parameter }) {
  const variable = sourceCode
    .getDeclaredVariables(callback)
    .find(({ identifiers }) => identifiers.includes(parameter))
  return variable?.references ?? []
}

// Why: a lambda forwards its parameter only when it returns one expression and reads the parameter nowhere else; the caller then checks where that single read sits.
export function forwardingLambda(sourceCode, callback) {
  const parameter = soleIdentifierParameter(callback)
  if (parameter === null) return null
  const returned = returnedExpression(callback)
  if (returned === null) return null
  const references = referencesOf(sourceCode, { callback, parameter })
  if (references.length !== 1) return null
  return { returned, parameterRead: references[0].identifier }
}

// Why: without types a Schema.Class `make(props, options)` or a prototype method (`this.handle`) cannot be told from a plain function, and both stay wrapped (effect.md) — only an inline function or a bare identifier is known to move as is.
export function isForwardableFunction(node) {
  return isFunction(node) || node?.type === 'Identifier'
}
