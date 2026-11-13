import { isFunction, isModuleMember } from './effect-ast.js'
import { isJustified } from './justification.js'

const optionModules = new Set(['Option'])

const controlFlowStatements = new Set([
  'IfStatement',
  'SwitchStatement',
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
  'WhileStatement',
  'DoWhileStatement',
  'TryStatement',
])

function isOptionCall(node, names) {
  return (
    node?.type === 'CallExpression' &&
    isModuleMember(node.callee, optionModules) &&
    node.callee.property.type === 'Identifier' &&
    names.has(node.callee.property.name)
  )
}

const optionConstructors = new Set(['some', 'none'])
const optionGenerator = new Set(['gen'])

function isOptionConstructor(node) {
  return isOptionCall(node, optionConstructors)
}

function isUnderControlFlow(node) {
  let current = node.parent
  while (current && !isFunction(current)) {
    if (controlFlowStatements.has(current.type)) return true
    current = current.parent
  }
  return false
}

const branchingReturn = 'branchingReturn'
const conditionalOption = 'conditionalOption'
const optionGen = 'optionGen'

const optionBuiltByPipe = {
  meta: {
    type: 'suggestion',
    messages: {
      [branchingReturn]:
        'Build this Option with a pipe of Option combinators (`Array.findFirst`, `Option.liftPredicate`, `Option.filter`, `OptionExtra.when`, `Option.fromNullOr`, `Option.orElse`, `Option.firstSomeOf`) instead of returning `Option.some` / `Option.none` from a branch; keep it only with a `// Why:` line.',
      [conditionalOption]:
        'Do not choose an Option with a ternary: use `Option.liftPredicate` / `Option.filter` (then `Option.map`) to keep a value, `OptionExtra.when(condition, () => value)` to build one only if a condition holds, `Option.orElse` to fall back, or `Option.some(condition ? a : b)` to choose the value; keep it only with a `// Why:` line.',
      [optionGen]:
        'Write this Option as a pipe of combinators; keep `Option.gen` only with a `// Why:` line saying what the pipe cannot express.',
    },
  },
  create(context) {
    function report(node, messageId) {
      if (isJustified(context.sourceCode, node)) return
      context.report({ node, messageId })
    }
    return {
      ReturnStatement(node) {
        if (!isOptionConstructor(node.argument)) return
        if (!isUnderControlFlow(node)) return
        report(node, branchingReturn)
      },
      ConditionalExpression(node) {
        const choosesAnOption =
          isOptionConstructor(node.consequent) ||
          isOptionConstructor(node.alternate)
        if (!choosesAnOption) return
        report(node, conditionalOption)
      },
      CallExpression(node) {
        if (!isOptionCall(node, optionGenerator)) return
        report(node.callee, optionGen)
      },
    }
  },
}

export default optionBuiltByPipe
