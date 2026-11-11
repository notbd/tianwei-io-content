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
  },
})
