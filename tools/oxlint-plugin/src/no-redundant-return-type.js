const messageId = 'redundantReturnType'

const noRedundantReturnType = {
  meta: {
    type: 'suggestion',
    fixable: 'code',
    messages: {
      [messageId]:
        "Method '{{method}}' is constrained by an implemented interface; drop the explicit return type and let it be inferred.",
    },
  },
  create(context) {
    return {
      MethodDefinition(node) {
        if (node.kind !== 'method') return
        if (node.static === true) return
        if (node.computed === true) return
        if (
          node.accessibility === 'private' ||
          node.accessibility === 'protected'
        ) {
          return
        }
        if (node.key.type === 'PrivateIdentifier') return

        const methodFunction = node.value
        if (!methodFunction.body) return

        const returnTypeAnnotation = methodFunction.returnType
        if (!returnTypeAnnotation) return

        const classBody = node.parent
        const classNode = classBody ? classBody.parent : undefined
        if (!classNode) return

        // Why: interface membership is not resolvable without type info, so the
        // rule treats every public instance method of an `implements` class as
        // interface-constrained (helpers are `private` by convention).
        const implementsClause = classNode.implements
        if (!implementsClause || implementsClause.length === 0) return

        const methodName =
          node.key.type === 'Identifier' ? node.key.name : '<computed>'

        context.report({
          messageId,
          node: returnTypeAnnotation,
          data: { method: methodName },
          fix(fixer) {
            return fixer.remove(returnTypeAnnotation)
          },
        })
      },
    }
  },
}

export default noRedundantReturnType
