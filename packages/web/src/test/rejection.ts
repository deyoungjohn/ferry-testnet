export async function rejectionMessage(
  promise: Promise<unknown>,
): Promise<string> {
  try {
    await promise;
  } catch (cause) {
    if (
      cause !== null &&
      typeof cause === 'object' &&
      'message' in cause &&
      typeof cause.message === 'string'
    ) {
      return cause.message;
    }
    return String(cause);
  }

  throw new Error('Expected promise to reject');
}
