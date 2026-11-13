const messageId = 'shorthandAfterKeyValue'

const spreadTypes = new Set(['SpreadElement', 'RestElement'])

function isShorthand(member) {
  return member.type === 'Property' && member.shorthand === true
}

function isBoundary(member) {
  return spreadTypes.has(member.type) || member.computed === true
}

function segmentsOf(node) {
  const segments = [{ start: node.range[0] + 1, members: [] }]
  for (const member of node.properties) {
    if (isBoundary(member)) segments.push({ start: member.range[1], members: [] })
    else segments.at(-1).members.push(member)
  }
  return segments.filter(({ members }) => members.length > 1)
}

function misplacedShorthandsOf(members) {
  const firstKeyValueIndex = members.findIndex(
    (member) => !isShorthand(member),
  )
  if (firstKeyValueIndex === -1) return []
  return members.slice(firstKeyValueIndex + 1).filter(isShorthand)
}

function segmentEnd({ node, members }) {
  const lastMember = members.at(-1)
  const followingMember = node.properties.find(
    ({ range }) => range[0] >= lastMember.range[1],
  )
  return followingMember ? followingMember.range[0] : node.range[1]
}

function holdsComments({ sourceCode, node, segment }) {
  const { start, members } = segment
  const end = segmentEnd({ node, members })
  return sourceCode
    .getAllComments()
    .some(({ range }) => range[0] >= start && range[1] <= end)
}

function isConstantDefault(right) {
  if (right.type === 'Literal') return true
  return right.type === 'TemplateLiteral' && right.expressions.length === 0
}

function boundName(value) {
  if (value.type === 'Identifier') return value.name
  const isConstantlyDefaulted =
    value.type === 'AssignmentPattern' &&
    value.left.type === 'Identifier' &&
    isConstantDefault(value.right)
  return isConstantlyDefaulted ? value.left.name : null
}

function bindsDistinctPlainIdentifiers(members) {
  const names = members.map(({ value }) => boundName(value))
  return !names.includes(null) && new Set(names).size === names.length
}

function staticKeyName({ key }) {
  if (key.type === 'Identifier') return key.name
  return key.type === 'Literal' ? String(key.value) : null
}

function isReassigned(sourceCode, identifier) {
  const variable = sourceCode
    .getScope(identifier)
    .references.find((reference) => reference.identifier === identifier)
    ?.resolved
  if (!variable) return true
  return variable.references.some(
    (reference) => reference.isWrite() && !reference.init,
  )
}

function readsStableValues({ sourceCode, members }) {
  const shorthands = members.filter(isShorthand)
  const shorthandNames = new Set(shorthands.map(({ key }) => key.name))
  const isAnyKeyRepeated = members
    .filter((member) => !isShorthand(member))
    .some((member) => shorthandNames.has(staticKeyName(member)))
  return (
    !isAnyKeyRepeated &&
    !shorthands.some(({ value }) => isReassigned(sourceCode, value))
  )
}

function keepsEvaluationOrder({ sourceCode, node, members }) {
  return node.type === 'ObjectPattern'
    ? bindsDistinctPlainIdentifiers(members)
    : readsStableValues({ sourceCode, members })
}

function reorderedText({ sourceCode, members }) {
  const reordered = [
    ...members.filter(isShorthand),
    ...members.filter((member) => !isShorthand(member)),
  ]
  const { text } = sourceCode
  return members
    .map((member, index) => {
      const separator =
        index === members.length - 1
          ? ''
          : text.slice(member.range[1], members[index + 1].range[0])
      return sourceCode.getText(reordered[index]) + separator
    })
    .join('')
}

function fixFor({ sourceCode, members }) {
  const range = [members[0].range[0], members.at(-1).range[1]]
  return (fixer) =>
    fixer.replaceTextRange(range, reorderedText({ sourceCode, members }))
}

function isFixable({ sourceCode, node, segment }) {
  const { members } = segment
  return (
    keepsEvaluationOrder({ sourceCode, node, members }) &&
    !holdsComments({ sourceCode, node, segment })
  )
}

function fixesFor({ sourceCode, node, segment }) {
  return isFixable({ sourceCode, node, segment })
    ? { fix: fixFor({ sourceCode, members: segment.members }) }
    : {}
}

const shorthandPropertiesFirst = {
  meta: {
    type: 'suggestion',
    fixable: 'code',
    messages: {
      [messageId]:
        "Shorthand property '{{name}}' follows a key-value pair; list shorthand properties first.",
    },
  },
  create(context) {
    const { sourceCode } = context
    function reportSegment({ node, segment }) {
      const misplacedShorthands = misplacedShorthandsOf(segment.members)
      for (const [index, shorthand] of misplacedShorthands.entries()) {
        context.report({
          messageId,
          node: shorthand,
          data: { name: sourceCode.getText(shorthand.key) },
          ...(index === 0 ? fixesFor({ sourceCode, node, segment }) : {}),
        })
      }
    }
    function check(node) {
      for (const segment of segmentsOf(node)) {
        reportSegment({ node, segment })
      }
    }
    return {
      ObjectExpression: check,
      ObjectPattern: check,
    }
  },
}

export default shorthandPropertiesFirst
