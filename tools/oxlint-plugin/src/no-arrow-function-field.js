const messageId = 'arrowFunctionField'

const functionValueTypes = new Set([
  'ArrowFunctionExpression',
  'FunctionExpression',
])

const typeWrapperTypes = new Set([
  'TSAsExpression',
  'TSInstantiationExpression',
  'TSNonNullExpression',
  'TSSatisfiesExpression',
  'TSTypeAssertion',
])

function unwrapTypeWrappers(node) {
  return typeWrapperTypes.has(node.type)
    ? unwrapTypeWrappers(node.expression)
    : node
}

function holdsAFunction({ value }) {
  return Boolean(value) && functionValueTypes.has(unwrapTypeWrappers(value).type)
}

function fieldNameOf(key) {
  if (key.type === 'Identifier') return key.name
  if (key.type === 'Literal') return String(key.value)
  return '<computed>'
}

function isPrivate(field) {
  return (
    field.accessibility === 'private' || field.key.type === 'PrivateIdentifier'
  )
}

const noArrowFunctionField = {
  meta: {
    type: 'suggestion',
    messages: {
      [messageId]:
        "Field '{{field}}' holds a function; implement it as a method and call it from an arrow callback where `this` must stay bound.",
    },
  },
  create(context) {
    function check(field) {
      if (field.static === true || isPrivate(field)) return
      // Why: a field overriding a base class property cannot become a method (TS2425).
      if (field.override === true) return
      if (!holdsAFunction(field)) return
      context.report({
        messageId,
        node: field,
        data: { field: fieldNameOf(field.key) },
      })
    }
    return {
      PropertyDefinition: check,
      AccessorProperty: check,
    }
  },
}

export default noArrowFunctionField
