/**
 * Prisma error codes the app actually branches on.
 *
 * `P2002` is a unique constraint violation. It is load-bearing in billing
 * rather than incidental: both redeeming a code and settling a payment rely on
 * a unique index to make a repeated request a no-op instead of a second grant,
 * so recognising it IS the idempotency, not error handling around it.
 */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === 'P2002'
  );
}
