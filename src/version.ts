/**
 * Build identity, baked into the image by the Dockerfile's runner stage and
 * served on `/` and `/health`. Outside a built image nothing is set, and the
 * fallbacks say `dev` rather than inventing a version number.
 */
export const BUILD_INFO = {
  version: process.env.APP_VERSION ?? 'dev',
  commit: process.env.APP_COMMIT ?? 'unknown',
  builtAt: process.env.APP_BUILT_AT ?? null,
} as const;
