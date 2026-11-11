import antfu from '@antfu/eslint-config'

export default antfu({
  // byte-for-byte copies of other services' output (the frontend's /contract.json)
  ignores: ['tests/fixtures/**'],
  rules: {
    'no-console': [
      'error',
      {
        allow: ['warn', 'error', 'info'],
      },
    ],
    // one way to declare object types (unions already need `type`), as in the web repo
    'ts/consistent-type-definitions': ['error', 'type'],
  },
})
