import effectPipeEndsWithSpan from './effect-pipe-ends-with-span.js'
import noArrowFunctionField from './no-arrow-function-field.js'
import noNestedEffectPipe from './no-nested-effect-pipe.js'
import noNewOutsideDeclaringModule from './no-new-outside-declaring-module.js'
import noRedundantReturnType from './no-redundant-return-type.js'
import noUnjustifiedEffectGen from './no-unjustified-effect-gen.js'
import optionBuiltByPipe from './option-built-by-pipe.js'
import preferDataLastArrayMethod from './prefer-data-last-array-method.js'
import preferDataLastForEach from './prefer-data-last-for-each.js'
import preferDestructuredParameter from './prefer-destructured-parameter.js'
import preferEffectAs from './prefer-effect-as.js'
import preferEffectFromOption from './prefer-effect-from-option.js'
import preferEffectOptionMap from './prefer-effect-option-map.js'
import preferEffectServiceAll from './prefer-effect-service-all.js'
import preferErrorMapTag from './prefer-error-map-tag.js'
import preferMatchValueTags from './prefer-match-value-tags.js'
import shorthandPropertiesFirst from './shorthand-properties-first.js'
import spanNameFromComponentConstant from './span-name-from-component-constant.js'

const plugin = {
  meta: { name: 'template' },
  rules: {
    'effect-pipe-ends-with-span': effectPipeEndsWithSpan,
    'no-arrow-function-field': noArrowFunctionField,
    'no-nested-effect-pipe': noNestedEffectPipe,
    'no-new-outside-declaring-module': noNewOutsideDeclaringModule,
    'no-redundant-return-type': noRedundantReturnType,
    'no-unjustified-effect-gen': noUnjustifiedEffectGen,
    'option-built-by-pipe': optionBuiltByPipe,
    'prefer-data-last-array-method': preferDataLastArrayMethod,
    'prefer-data-last-for-each': preferDataLastForEach,
    'prefer-destructured-parameter': preferDestructuredParameter,
    'prefer-effect-as': preferEffectAs,
    'prefer-effect-from-option': preferEffectFromOption,
    'prefer-effect-option-map': preferEffectOptionMap,
    'prefer-effect-service-all': preferEffectServiceAll,
    'prefer-error-map-tag': preferErrorMapTag,
    'prefer-match-value-tags': preferMatchValueTags,
    'shorthand-properties-first': shorthandPropertiesFirst,
    'span-name-from-component-constant': spanNameFromComponentConstant,
  },
}

export default plugin
