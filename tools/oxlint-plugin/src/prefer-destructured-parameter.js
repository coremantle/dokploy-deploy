import { isFunction } from './effect-ast.js'

const messageId = 'preferDestructuredParameter'

// Why: must equal `printWidth` in the root .oxfmtrc.json (pinned by a test), so a fix never triggers a reflow.
export const printWidth = 80

const reservedWords = new Set([
  'arguments',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'eval',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'let',
  'new',
  'null',
  'package',
  'private',
  'protected',
  'public',
  'return',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'undefined',
  'var',
  'void',
  'while',
  'with',
  'yield',
])

const subjectlessPropertyNames = new Set(['length'])

const narrowingNodeTypes = new Set([
  'LogicalExpression',
  'ConditionalExpression',
  'IfStatement',
  'SwitchStatement',
  'WhileStatement',
  'DoWhileStatement',
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
])

const loopNodeTypes = new Set([
  'WhileStatement',
  'DoWhileStatement',
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
])

const deferringNodeTypes = new Set([
  'PropertyDefinition',
  'AccessorProperty',
  'StaticBlock',
])

const barrierNodeTypes = new Set([
  'AssignmentExpression',
  'UpdateExpression',
  'ReturnStatement',
  'ThrowStatement',
  'BreakStatement',
  'ContinueStatement',
])

const logicalAssignmentOperators = new Set(['||=', '&&=', '??='])

const transparentWrapperTypes = new Set([
  'TSNonNullExpression',
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSTypeAssertion',
  'ChainExpression',
])

function childNodesOf(node) {
  const childNodes = []
  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent') continue
    const candidates = Array.isArray(value) ? value : [value]
    for (const candidate of candidates) {
      if (candidate && typeof candidate.type === 'string') {
        childNodes.push(candidate)
      }
    }
  }
  return childNodes
}

function someDescendant(node, { predicate, crossFunctions }) {
  return childNodesOf(node).some(
    (childNode) =>
      predicate(childNode) ||
      ((crossFunctions || !isFunction(childNode)) &&
        someDescendant(childNode, { predicate, crossFunctions })),
  )
}

function* descendantsOf(node) {
  for (const childNode of childNodesOf(node)) {
    yield childNode
    if (!isFunction(childNode)) yield* descendantsOf(childNode)
  }
}

function isOnLoopIteration(loop, child) {
  if (loop.type === 'ForInStatement' || loop.type === 'ForOfStatement') {
    return child !== loop.right
  }
  if (loop.type === 'ForStatement') return child !== loop.init
  return true
}

function isConditionallyEvaluated(parent, child) {
  switch (parent.type) {
    case 'ConditionalExpression':
    case 'IfStatement':
      return child !== parent.test
    case 'LogicalExpression':
      return child === parent.right
    case 'AssignmentExpression':
      return (
        logicalAssignmentOperators.has(parent.operator) &&
        child === parent.right
      )
    case 'SwitchCase':
    case 'TryStatement':
    case 'CatchClause':
      return true
    default:
      return loopNodeTypes.has(parent.type) && isOnLoopIteration(parent, child)
  }
}

function isChainHead(parent, child) {
  return (
    (parent.type === 'MemberExpression' && parent.object === child) ||
    (parent.type === 'CallExpression' && parent.callee === child)
  )
}

function isReadOnceOnEntry(memberExpression, functionNode) {
  let child = memberExpression
  let onChainHead = true
  while (child.parent && child.parent !== functionNode) {
    const { parent } = child
    if (isFunction(parent) || deferringNodeTypes.has(parent.type)) return false
    if (isConditionallyEvaluated(parent, child)) return false
    if (parent.type === 'ChainExpression' && !onChainHead) return false
    onChainHead = onChainHead && isChainHead(parent, child)
    child = parent
  }
  return child.parent === functionNode
}

function firstBarrierEnd(functionNode) {
  let earliestEnd = Number.POSITIVE_INFINITY
  for (const node of descendantsOf(functionNode)) {
    const isBarrier =
      barrierNodeTypes.has(node.type) ||
      (node.type === 'UnaryExpression' && node.operator === 'delete')
    if (isBarrier) earliestEnd = Math.min(earliestEnd, node.range[1])
  }
  return earliestEnd
}

function hasUseStrictDirective(functionNode) {
  const { body } = functionNode
  return (
    body.type === 'BlockStatement' &&
    body.body.some(({ directive }) => directive === 'use strict')
  )
}

function outermostWrapperOf(node) {
  let current = node
  while (current.parent && transparentWrapperTypes.has(current.parent.type)) {
    current = current.parent
  }
  return current
}

function isWrittenOrBound(memberExpression) {
  const expression = outermostWrapperOf(memberExpression)
  const { parent } = expression
  switch (parent.type) {
    case 'CallExpression':
      return parent.callee === expression
    case 'TaggedTemplateExpression':
      return parent.tag === expression
    case 'AssignmentExpression':
    case 'AssignmentPattern':
    case 'ForInStatement':
    case 'ForOfStatement':
      return parent.left === expression
    case 'UpdateExpression':
    case 'ArrayPattern':
    case 'RestElement':
      return true
    case 'UnaryExpression':
      return parent.operator === 'delete'
    case 'Property':
      return parent.parent.type === 'ObjectPattern'
    default:
      return false
  }
}

function propertyReadOf(reference, functionNode) {
  const { identifier } = reference
  const memberExpression = identifier.parent
  if (memberExpression.type !== 'MemberExpression') return
  if (memberExpression.object !== identifier) return
  if (memberExpression.computed || memberExpression.optional) return
  if (memberExpression.property.type !== 'Identifier') return
  if (isWrittenOrBound(memberExpression)) return
  if (!isReadOnceOnEntry(memberExpression, functionNode)) return
  return memberExpression
}

function replacementOf(memberExpression) {
  const propertyName = memberExpression.property.name
  const { parent } = memberExpression
  const becomesShorthand =
    parent.type === 'Property' &&
    parent.parent.type === 'ObjectExpression' &&
    parent.value === memberExpression &&
    parent.kind === 'init' &&
    !parent.computed &&
    !parent.method &&
    parent.key.type === 'Identifier' &&
    parent.key.name === propertyName
  return {
    propertyName,
    replacedNode: becomesShorthand ? parent : memberExpression,
  }
}

function scopesWithin(scope) {
  return [scope, ...scope.childScopes.flatMap(scopesWithin)]
}

function namesInUse(functionScope, parameterVariable) {
  const names = new Set()
  for (const scope of scopesWithin(functionScope)) {
    for (const variable of scope.variables) {
      if (variable !== parameterVariable) names.add(variable.name)
    }
    for (const reference of scope.references) {
      if (reference.resolved !== parameterVariable) {
        names.add(reference.identifier.name)
      }
    }
  }
  return names
}

function isDeclaredAbove({ upper }, name) {
  let scope = upper
  while (scope && scope.type !== 'global') {
    if (scope.set.has(name)) return true
    scope = scope.upper
  }
  return false
}

function lineAfterFix({ lines }, { parameter, parameterText, replacements }) {
  const { start, end } = parameter.loc
  const line = lines[start.line - 1]
  const suffix = end.line === start.line ? line.slice(end.column) : ''
  const savedOnLine = sumOf(
    replacements
      .filter(
        ({ replacedNode }) =>
          replacedNode.loc.start.line === start.line &&
          replacedNode.loc.end.line === start.line,
      )
      .map(
        ({ propertyName, replacedNode }) =>
          lengthOf(replacedNode) - propertyName.length,
      ),
  )
  const firstLineOfParameter = parameterText.split('\n')[0]
  return {
    lengthBefore: line.length,
    lengthAfter:
      start.column + firstLineOfParameter.length + suffix.length - savedOnLine,
  }
}

function overflowsLine(sourceCode, fix) {
  const { lengthBefore, lengthAfter } = lineAfterFix(sourceCode, fix)
  return lengthAfter > printWidth && lengthAfter > lengthBefore
}

function mentionsParameterInType(functionNode, parameterName) {
  return someDescendant(functionNode, {
    crossFunctions: true,
    predicate: (node) =>
      (node.type === 'TSTypePredicate' &&
        node.parameterName?.name === parameterName) ||
      (node.type === 'TSTypeQuery' &&
        rootNameOf(node.exprName) === parameterName),
  })
}

function rootNameOf(entityName) {
  let current = entityName
  while (current && current.type === 'TSQualifiedName') current = current.left
  return current?.type === 'Identifier' ? current.name : undefined
}

function narrowsInBody({ body }) {
  return someDescendant(body, {
    crossFunctions: false,
    predicate: ({ type }) => narrowingNodeTypes.has(type),
  })
}

function hasParentheses(sourceCode, { functionNode, parameter }) {
  if (functionNode.type !== 'ArrowFunctionExpression') return true
  if (functionNode.params.length > 1) return true
  const tokenBeforeParameter = sourceCode.getTokenBefore(parameter)
  return (
    tokenBeforeParameter?.value === '(' &&
    tokenBeforeParameter.range[0] >= functionNode.range[0]
  )
}

function sumOf(numbers) {
  let total = 0
  for (const number of numbers) total += number
  return total
}

function lengthOf({ range }) {
  return range[1] - range[0]
}

function analyseParameter({
  context,
  functionNode,
  parameter,
  variable,
  barrierEndOf,
}) {
  const { sourceCode } = context
  if (variable.references.length === 0) return

  const propertyReads = []
  for (const reference of variable.references) {
    const memberExpression = propertyReadOf(reference, functionNode)
    if (!memberExpression) return
    propertyReads.push(memberExpression)
  }
  const barrierEnd = barrierEndOf()
  if (propertyReads.some(({ range }) => range[0] >= barrierEnd)) return
  const replacements = propertyReads.map(replacementOf)
  if (mentionsParameterInType(functionNode, parameter.name)) return

  const propertyNames = [
    ...new Set(replacements.map(({ propertyName }) => propertyName)),
  ]
  const isAnyNameUnbindable = propertyNames.some(
    (propertyName) =>
      reservedWords.has(propertyName) ||
      subjectlessPropertyNames.has(propertyName),
  )
  if (isAnyNameUnbindable) return
  if (propertyNames.length > 1 && narrowsInBody(functionNode)) return

  const functionScope = sourceCode.getScope(functionNode)
  const usedNames = namesInUse(functionScope, variable)
  const isAnyNameTaken = propertyNames.some(
    (propertyName) =>
      usedNames.has(propertyName) ||
      isDeclaredAbove(functionScope, propertyName),
  )
  if (isAnyNameTaken) return

  const typeAnnotationText = parameter.typeAnnotation
    ? sourceCode.getText(parameter.typeAnnotation)
    : ''
  const patternText = `{ ${propertyNames.join(', ')} }`
  const annotatedPatternText = `${patternText}${typeAnnotationText}`
  const parameterText = hasParentheses(sourceCode, { functionNode, parameter })
    ? annotatedPatternText
    : `(${annotatedPatternText})`

  const savedCharacters =
    lengthOf(parameter) -
    parameterText.length +
    sumOf(
      replacements.map(
        ({ propertyName, replacedNode }) =>
          lengthOf(replacedNode) - propertyName.length,
      ),
    )
  if (savedCharacters <= 0) return
  if (overflowsLine(sourceCode, { parameter, parameterText, replacements })) {
    return
  }

  return { parameterText, patternText, replacements }
}

const preferDestructuredParameter = {
  meta: {
    type: 'suggestion',
    fixable: 'code',
    messages: {
      [messageId]:
        "Parameter '{{parameter}}' is only read through its properties; destructure it as `{{pattern}}`, which is shorter.",
    },
  },
  create(context) {
    function check(functionNode) {
      if (!functionNode.body || functionNode.generator) return
      if (hasUseStrictDirective(functionNode)) return
      const declaredVariables =
        context.sourceCode.getDeclaredVariables(functionNode)
      let barrierEnd
      function barrierEndOf() {
        barrierEnd ??= firstBarrierEnd(functionNode)
        return barrierEnd
      }
      for (const parameter of functionNode.params) {
        if (parameter.type !== 'Identifier' || parameter.name === 'this') {
          continue
        }
        if (parameter.optional || (parameter.decorators?.length ?? 0) > 0) {
          continue
        }
        const variable = declaredVariables.find(({ identifiers }) =>
          identifiers.includes(parameter),
        )
        if (!variable) continue
        const analysis = analyseParameter({
          context,
          functionNode,
          parameter,
          variable,
          barrierEndOf,
        })
        if (!analysis) continue
        context.report({
          messageId,
          node: parameter,
          data: { parameter: parameter.name, pattern: analysis.patternText },
          fix: (fixer) => [
            fixer.replaceText(parameter, analysis.parameterText),
            ...analysis.replacements.map(({ propertyName, replacedNode }) =>
              fixer.replaceText(replacedNode, propertyName),
            ),
          ],
        })
      }
    }
    return {
      ArrowFunctionExpression: check,
      FunctionExpression: check,
      FunctionDeclaration: check,
    }
  },
}

export default preferDestructuredParameter
