export function isModuleMember(node, moduleNames) {
  return (
    node.type === 'MemberExpression' &&
    node.computed === false &&
    node.object.type === 'Identifier' &&
    moduleNames.has(node.object.name)
  )
}

// Why: `EffectOption` and `EffectService` steps are effects too — a pipe of `@template/effect` combinators alone still returns an Effect that needs its span.
const effectModules = new Set(['Effect', 'EffectOption', 'EffectService'])

function referencesEffect(node) {
  if (isModuleMember(node, effectModules)) return true
  return (
    node.type === 'CallExpression' && isModuleMember(node.callee, effectModules)
  )
}

function isMethodPipeCallee(callee) {
  return (
    callee.type === 'MemberExpression' &&
    callee.computed === false &&
    callee.property.type === 'Identifier' &&
    callee.property.name === 'pipe'
  )
}

export function isPipe(node) {
  if (node.type !== 'CallExpression') return false
  const { callee } = node
  const isFreePipe = callee.type === 'Identifier' && callee.name === 'pipe'
  return isFreePipe || isMethodPipeCallee(callee)
}

export function isEffectPipe(node) {
  if (!isPipe(node)) return false
  if (node.arguments.some(referencesEffect)) return true
  return isMethodPipeCallee(node.callee) && referencesEffect(node.callee.object)
}

// Why: Effect 4 declares these with `dual(2, …)` and their pipeable form takes exactly one argument, so a second argument always means `self` came first; duals whose pipeable form takes two (`zipWith`, `catchTag`, `filterOrFail`) would be ambiguous.
const dataFirstCombinators = new Set(['map', 'flatMap', 'andThen', 'tap', 'as'])
export const effectModule = new Set(['Effect'])

export function moduleMemberName(callee, moduleNames) {
  if (!isModuleMember(callee, moduleNames)) return null
  if (callee.property.type !== 'Identifier') return null
  return callee.property.name
}

export function isDataFirstComposition(node) {
  if (node.type !== 'CallExpression') return false
  const name = moduleMemberName(node.callee, effectModule)
  if (!dataFirstCombinators.has(name)) return false
  const [self] = node.arguments
  return node.arguments.length >= 2 && !isFunction(self)
}

export function isComposition(node) {
  return isPipe(node) || isDataFirstComposition(node)
}

export function isEffectComposition(node) {
  return isEffectPipe(node) || isDataFirstComposition(node)
}

export function isCallTo(node, { moduleNames, names }) {
  return (
    node?.type === 'CallExpression' &&
    names.has(moduleMemberName(node.callee, moduleNames))
  )
}

function isComponentFactoryCall(node) {
  const callee = node?.type === 'CallExpression' ? node.callee : null
  return (
    callee?.type === 'MemberExpression' &&
    callee.computed === false &&
    callee.property.type === 'Identifier' &&
    callee.property.name === 'make'
  )
}

const constructionPrimitives = [
  { moduleNames: effectModule, names: new Set(['service', 'context']) },
  { moduleNames: new Set(['EffectService']), names: new Set(['all']) },
  {
    moduleNames: new Set(['Ref', 'SynchronizedRef']),
    names: new Set(['make']),
  },
  {
    moduleNames: new Set(['PubSub', 'Queue']),
    names: new Set(['unbounded', 'bounded', 'dropping', 'sliding', 'make']),
  },
]

function isConstructionPrimitive(node) {
  return (
    constructionPrimitives.some((primitive) => isCallTo(node, primitive)) ||
    isComponentFactoryCall(node)
  )
}

function collectionElements(node) {
  if (node?.type === 'ArrayExpression') return node.elements
  if (node?.type !== 'ObjectExpression') return []
  return node.properties.map((property) =>
    property.type === 'Property' ? property.value : property,
  )
}

const effectAll = { moduleNames: effectModule, names: new Set(['all']) }

function isConstructionSource(node) {
  if (isConstructionPrimitive(node)) return true
  if (!isCallTo(node, effectAll)) return false
  const elements = collectionElements(node.arguments[0])
  return elements.length > 0 && elements.every(isConstructionPrimitive)
}

// Why: a data-first `Effect.map` over construction primitives only — `Effect.service`, `EffectService.all`, `Effect.context`, `Ref.make`, `SynchronizedRef.make`, a `PubSub` or `Queue` constructor, another `X.make(…)`, or an `Effect.all` of those — builds a component from its dependencies, with no work a span would measure.
export function isConstruction(node) {
  if (!isDataFirstComposition(node)) return false
  if (moduleMemberName(node.callee, effectModule) !== 'map') return false
  return isConstructionSource(node.arguments[0])
}

export function isFunction(node) {
  return (
    node?.type === 'FunctionDeclaration' ||
    node?.type === 'FunctionExpression' ||
    node?.type === 'ArrowFunctionExpression'
  )
}

// Why: only named units — functions, methods, functions bound to a variable or class field — own a span; a pipe inside a combinator's callback lives under its method's span.
export function isNamedFunction(functionNode) {
  if (functionNode.type === 'FunctionDeclaration') return true
  const { parent } = functionNode
  if (!parent) return false
  if (parent.type === 'MethodDefinition') {
    return parent.kind === 'method' || parent.kind === 'get'
  }
  return (
    parent.type === 'PropertyDefinition' || parent.type === 'VariableDeclarator'
  )
}

export function isObjectLiteralMethod({ parent }) {
  return parent?.type === 'Property'
}

export function enclosingFunction(node) {
  let current = node.parent
  while (current && !isFunction(current)) {
    current = current.parent
  }
  return current
}

const spanModules = new Set(['Effect', 'Stream'])

export function isSpanCall(node) {
  return (
    node.type === 'CallExpression' &&
    isModuleMember(node.callee, spanModules) &&
    node.callee.property.type === 'Identifier' &&
    node.callee.property.name === 'withSpan'
  )
}

const clientEffectFactories = new Set(['atom', 'fn'])

// Why: `runtime.atom(effect)` / `runtime.fn(effect)` is how client code names an effect; `Effect.fn` is another API and stays out.
export function isClientEffectCall(node) {
  if (node.type !== 'CallExpression') return false
  const { callee } = node
  return (
    callee.type === 'MemberExpression' &&
    callee.computed === false &&
    callee.property.type === 'Identifier' &&
    clientEffectFactories.has(callee.property.name) &&
    !(callee.object.type === 'Identifier' && callee.object.name === 'Effect')
  )
}

function isSubmitHandler(property, functionNode) {
  return (
    property.type === 'Property' &&
    property.computed === false &&
    property.key.type === 'Identifier' &&
    property.key.name === 'onSubmit' &&
    property.value === functionNode
  )
}

// Why: an atom's or a form's effect is a unit of client work with no enclosing method, so the callback handed to it owns the span.
export function isClientEffectCallback(functionNode) {
  const { parent } = functionNode
  if (!parent) return false
  if (isClientEffectCall(parent)) {
    return parent.arguments.includes(functionNode)
  }
  return isSubmitHandler(parent, functionNode)
}

function unwrapParentheses(node) {
  let current = node
  while (current?.type === 'ParenthesizedExpression') {
    current = current.expression
  }
  return current
}

// Why: a callback that only returns one expression — an expression body or a block holding a single `return` — is the shape every forwarding-lambda rule inspects.
export function returnedExpression(functionNode) {
  if (!isFunction(functionNode)) return null
  const { body } = functionNode
  if (body.type !== 'BlockStatement') return unwrapParentheses(body)
  const [statement] = body.body
  if (body.body.length !== 1 || statement.type !== 'ReturnStatement') {
    return null
  }
  return unwrapParentheses(statement.argument)
}

// Why: `Effect.map(f)` is the pipeable form and `Effect.map(self, f)` the data-first one; the callback is the last argument of either, provided `self` is not itself a function.
export function dualCallback(node) {
  const { arguments: callArguments } = node
  if (callArguments.length === 1) return callArguments[0]
  if (callArguments.length !== 2 || isFunction(callArguments[0])) return null
  return callArguments[1]
}

// Why: `pipe(source, …steps)` and `source.pipe(…steps)` are the same pipeline.
export function pipeSourceAndSteps(pipeCall) {
  const { callee, arguments: callArguments } = pipeCall
  if (callee.type === 'Identifier') {
    const [source, ...steps] = callArguments
    return { source, steps }
  }
  return { source: callee.object, steps: callArguments }
}

export function methodCallName({ callee, optional }) {
  const isPlainMethodCall =
    !optional &&
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    !callee.optional &&
    callee.property.type === 'Identifier'
  return isPlainMethodCall ? callee.property.name : null
}
