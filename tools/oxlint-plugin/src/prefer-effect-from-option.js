import {
  effectModule,
  isCallTo,
  isPipe,
  pipeSourceAndSteps,
} from './effect-ast.js'
import { isJustified } from './justification.js'

const effectSucceed = { moduleNames: effectModule, names: new Set(['succeed']) }
const effectOptionGetOrFail = {
  moduleNames: new Set(['EffectOption']),
  names: new Set(['getOrFail']),
}

function succeededOptionOpened(pipeCall) {
  if (!isPipe(pipeCall)) return null
  const {
    source,
    steps: [firstStep],
  } = pipeSourceAndSteps(pipeCall)
  const opensTheOption =
    isCallTo(source, effectSucceed) &&
    source.arguments.length === 1 &&
    isCallTo(firstStep, effectOptionGetOrFail)
  return opensTheOption ? source : null
}

const messageId = 'preferEffectFromOption'

const preferEffectFromOption = {
  meta: {
    type: 'suggestion',
    messages: {
      [messageId]:
        'Enter a pure Option that must be present with `Effect.fromOption(option, () => error)` instead of `Effect.succeed(option)` then `EffectOption.getOrFail`; keep it only with a `// Why:` line.',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const succeedCall = succeededOptionOpened(node)
        if (succeedCall === null) return
        const { sourceCode } = context
        const isJustifiedAtEitherEnd =
          isJustified(sourceCode, succeedCall) || isJustified(sourceCode, node)
        if (isJustifiedAtEitherEnd) return
        context.report({ messageId, node: succeedCall })
      },
    }
  },
}

export default preferEffectFromOption
