import noAssertionFreeTest from './rules/no-assertion-free-test.mjs'
import noAssertThrowsWithoutExpected from './rules/no-assert-throws-without-expected.mjs'
import noRestatingJsdoc from './rules/no-restating-jsdoc.mjs'
import noTautologicalAssert from './rules/no-tautological-assert.mjs'
import requirePublicJsdoc from './rules/public-api-jsdoc.mjs'

export default {
  meta: { name: 'eslint-plugin-dp' },
  rules: {
    'no-assertion-free-test': noAssertionFreeTest,
    'no-assert-throws-without-expected': noAssertThrowsWithoutExpected,
    'no-restating-jsdoc': noRestatingJsdoc,
    'no-tautological-assert': noTautologicalAssert,
    'require-public-jsdoc': requirePublicJsdoc,
  },
}
