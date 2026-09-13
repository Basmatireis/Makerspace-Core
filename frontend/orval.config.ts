import { defineConfig } from 'orval';

export default defineConfig({
  makerspace: {
    input: {
      target: '../api/openapi.yaml',
    },
    output: {
      target: './src/api/generated/makerspace.ts',
      schemas: './src/api/generated/models',
      mode: 'tags-split',
      client: 'fetch',
      baseUrl: '/api/v1',
      clean: true,
      prettier: false,
      override: {
        fetch: {
          includeHttpResponseReturnType: false,
        },
        mutator: {
          path: './src/api/http-client.ts',
          name: 'apiFetch',
        },
      },
    },
  },
});
