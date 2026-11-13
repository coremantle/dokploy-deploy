const justificationPattern = /^\s*\/\/ Why: \S/u

function isStatementLike(node) {
  return (
    node.type.endsWith('Statement') ||
    node.type.endsWith('Declaration') ||
    node.type === 'PropertyDefinition' ||
    node.type === 'MethodDefinition' ||
    node.type === 'Property'
  )
}

function enclosingStatement(node) {
  let current = node
  while (current.parent && !isStatementLike(current)) {
    current = current.parent
  }
  return current
}

function lineOf(sourceCode, node) {
  return sourceCode.getLocFromIndex(node.range[0]).line
}

const anyTopic = /(?:)/u

function isJustificationLine({ lines }, { line, topic }) {
  const text = lines[line - 1] ?? ''
  return justificationPattern.test(text) && topic.test(text)
}

// Why: a justification covers one node — the line right above it, or above its statement when the node opens that statement's first line — so it never spills over a sibling.
export function isJustifiedAbout(sourceCode, { node, topic }) {
  const nodeLine = lineOf(sourceCode, node)
  if (isJustificationLine(sourceCode, { topic, line: nodeLine - 1 }))
    return true
  const statementLine = lineOf(sourceCode, enclosingStatement(node))
  return (
    statementLine === nodeLine &&
    isJustificationLine(sourceCode, { topic, line: statementLine - 1 })
  )
}

export function isJustified(sourceCode, node) {
  return isJustifiedAbout(sourceCode, { node, topic: anyTopic })
}
