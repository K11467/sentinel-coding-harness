/**
 * Cleanup boundary for the opt-in macOS Keychain smoke test.
 *
 * Each operation is intentionally attempted even if a prior operation failed:
 * a temporary default Keychain must never prevent deleting the test keychain
 * or its directory. Error details are discarded because subprocess output may
 * contain machine-local paths or implementation details.
 */
export interface TemporaryKeychainSmokeCleanup {
  readonly restoreDefault?: () => Promise<void>;
  readonly deleteKeychain?: () => Promise<void>;
  readonly removeDirectory: () => Promise<void>;
}

export class TemporaryKeychainSmokeCleanupError extends Error {
  constructor(readonly failedSteps: readonly string[]) {
    super(`临时 Keychain 清理未完全完成：${failedSteps.join('、')}`);
    this.name = 'TemporaryKeychainSmokeCleanupError';
  }
}

/** Run all available cleanup operations, then report only safe step names. */
export async function cleanupTemporaryKeychainSmoke(operations: TemporaryKeychainSmokeCleanup): Promise<void> {
  const failedSteps: string[] = [];
  const attempt = async (step: string, operation: (() => Promise<void>) | undefined): Promise<void> => {
    if (!operation) return;
    try {
      await operation();
    } catch {
      failedSteps.push(step);
    }
  };

  await attempt('restore-default', operations.restoreDefault);
  await attempt('delete-keychain', operations.deleteKeychain);
  await attempt('remove-directory', operations.removeDirectory);

  if (failedSteps.length > 0) {
    throw new TemporaryKeychainSmokeCleanupError(failedSteps);
  }
}
