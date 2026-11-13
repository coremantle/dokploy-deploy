import { isJustified } from './justification.js'

const messageId = 'newOutsideDeclaringModule'

// Why: oxlint plugins have no type information, so a class "of the repository" is recognised by where its binding is imported from.
function isRepositoryModule(source) {
  return (
    source.startsWith('.') ||
    source.startsWith('#') ||
    source.startsWith('@template/')
  )
}

function isValueSpecifier(specifier) {
  return (
    specifier.type !== 'ImportNamespaceSpecifier' &&
    specifier.importKind !== 'type'
  )
}

const noNewOutsideDeclaringModule = {
  meta: {
    type: 'suggestion',
    messages: {
      [messageId]:
        'Build `{{className}}` through a named static factory; `new` is reserved to the module declaring the class (or needs a `// Why:` line).',
    },
  },
  create(context) {
    const importedClassNames = new Set()
    return {
      ImportDeclaration(node) {
        if (node.importKind === 'type') return
        if (!isRepositoryModule(node.source.value)) return
        for (const specifier of node.specifiers) {
          if (isValueSpecifier(specifier)) {
            importedClassNames.add(specifier.local.name)
          }
        }
      },
      NewExpression(node) {
        if (node.callee.type !== 'Identifier') return
        const className = node.callee.name
        if (!importedClassNames.has(className)) return
        if (isJustified(context.sourceCode, node)) return
        context.report({ node, messageId, data: { className } })
      },
    }
  },
}

export default noNewOutsideDeclaringModule
