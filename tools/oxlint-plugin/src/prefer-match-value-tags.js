import {
  isCallTo,
  isModuleMember,
  isPipe,
  pipeSourceAndSteps,
} from './effect-ast.js'
import { isJustified } from './justification.js'

const matchModule = new Set(['Match'])
const matchValue = { moduleNames: matchModule, names: new Set(['value']) }
const matchTag = { moduleNames: matchModule, names: new Set(['tag']) }

function isSingleTagStep(step) {
  if (!isCallTo(step, matchTag) || step.arguments.length !== 2) return false
  const [tag] = step.arguments
  return tag.type === 'Literal' && typeof tag.value === 'string'
}

function isExhaustive(step) {
  return (
    isModuleMember(step, matchModule) &&
    step.property.type === 'Identifier' &&
    step.property.name === 'exhaustive'
  )
}

// Why: a repeated tag only reaches its first handler in a chain, and would be a duplicate key in the `valueTags` record.
function hasDistinctTags(tagSteps) {
  const tags = tagSteps.map(({ arguments: [tag] }) => tag.value)
  return new Set(tags).size === tags.length
}

function oneHandlerPerTagMatch(node) {
  if (!isPipe(node)) return null
  const { source, steps } = pipeSourceAndSteps(node)
  if (!isCallTo(source, matchValue) || steps.length < 2) return null
  const tagSteps = steps.slice(0, -1)
  const isOneHandlerPerTag =
    tagSteps.every(isSingleTagStep) &&
    hasDistinctTags(tagSteps) &&
    isExhaustive(steps.at(-1))
  return isOneHandlerPerTag ? source : null
}

const messageId = 'preferMatchValueTags'

const preferMatchValueTags = {
  meta: {
    type: 'suggestion',
    messages: {
      [messageId]:
        'Every tag has its own handler: use `Match.valueTags(value, { Tag: handler })` instead of a `Match.value` chain of single-tag `Match.tag` steps ending with `Match.exhaustive`; keep it only with a `// Why:` line.',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const matchValueCall = oneHandlerPerTagMatch(node)
        if (matchValueCall === null) return
        const { sourceCode } = context
        const isJustifiedAtEitherEnd =
          isJustified(sourceCode, matchValueCall) ||
          isJustified(sourceCode, node)
        if (isJustifiedAtEitherEnd) return
        context.report({ messageId, node: matchValueCall })
      },
    }
  },
}

export default preferMatchValueTags
