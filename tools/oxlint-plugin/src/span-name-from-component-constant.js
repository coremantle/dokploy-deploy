import { isSpanCall } from './effect-ast.js'

const messageId = 'spanNameNotDerived'
const componentNameConstants = new Set([
  'useCaseName',
  'sagaName',
  'projectorName',
])

function declaredComponentConstant({ body }) {
  const declarators = body
    .map((statement) =>
      statement.type === 'ExportNamedDeclaration'
        ? statement.declaration
        : statement,
    )
    .filter(
      (declaration) =>
        declaration?.type === 'VariableDeclaration' &&
        declaration.kind === 'const',
    )
    .flatMap(({ declarations }) => declarations)
  const constant = declarators.find(
    (declarator) =>
      declarator.id.type === 'Identifier' &&
      componentNameConstants.has(declarator.id.name),
  )
  return constant?.id.name
}

function isTemplateOver(spanName, constantName) {
  const [firstExpression] = spanName.expressions
  const [leadingText, textAfterConstant] = spanName.quasis
  const operation = textAfterConstant?.value.cooked ?? ''
  return (
    leadingText.value.cooked === '' &&
    firstExpression?.type === 'Identifier' &&
    firstExpression.name === constantName &&
    (operation === '' || operation.startsWith('.'))
  )
}

// Why: without type information a variable or a call cannot be traced back to the constant, so only the shapes that visibly retype the name — a literal, a concatenation, a template starting elsewhere — are reported.
function derivesFrom(spanName, constantName) {
  if (spanName.type === 'TemplateLiteral') {
    return isTemplateOver(spanName, constantName)
  }
  return spanName.type !== 'Literal' && spanName.type !== 'BinaryExpression'
}

const spanNameFromComponentConstant = {
  meta: {
    type: 'suggestion',
    messages: {
      [messageId]:
        'This module names its component with `{{constantName}}`: derive the span name from it (`${{{constantName}}}.<operation>`) instead of retyping it.',
    },
  },
  create(context) {
    let constantName
    return {
      Program(node) {
        constantName = declaredComponentConstant(node)
      },
      CallExpression(node) {
        if (constantName === undefined || !isSpanCall(node)) return
        const [spanName] = node.arguments
        if (!spanName || derivesFrom(spanName, constantName)) return
        context.report({ messageId, node: spanName, data: { constantName } })
      },
    }
  },
}

export default spanNameFromComponentConstant
