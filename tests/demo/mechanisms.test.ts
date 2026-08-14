import { describe, expect, test } from 'vitest';
import {
  runApprovalOnceScenario,
  runDangerousActionScenario,
  runFeedbackAdaptationScenario,
  runMechanismScenarios
} from '../../src/demo/scenarios.js';

describe('deterministic mechanism demo scenarios', () => {
  test('blocks a dangerous action before a dispatcher can receive it', async () => {
    await expect(runDangerousActionScenario()).resolves.toEqual({
      name: 'dangerous-action',
      status: 'blocked',
      stopReason: 'policy_denied',
      dispatchedActions: 0
    });
  });

  test('uses summarized failure feedback to make the context-sensitive mock choose a different action', async () => {
    await expect(runFeedbackAdaptationScenario()).resolves.toEqual({
      name: 'feedback-adaptation',
      status: 'completed',
      firstAction: 'run_tests',
      nextAction: 'remember',
      feedbackCategory: 'assertion_failed',
      feedbackObserved: true
    });
  });

  test('requests, approves, and claims exactly once before restoring the pending session', async () => {
    await expect(runApprovalOnceScenario()).resolves.toEqual({
      name: 'approval-once',
      waitingStatus: 'waiting_approval',
      resumedStatus: 'running',
      claimedAction: 'write_file',
      approvalStatus: 'consumed',
      replayError: 'approval_consumed'
    });
  });

  test('returns a stable, CLI-ready aggregate report', async () => {
    await expect(runMechanismScenarios()).resolves.toEqual({
      passed: true,
      scenarios: [
        {
          name: 'dangerous-action',
          status: 'blocked',
          stopReason: 'policy_denied',
          dispatchedActions: 0
        },
        {
          name: 'feedback-adaptation',
          status: 'completed',
          firstAction: 'run_tests',
          nextAction: 'remember',
          feedbackCategory: 'assertion_failed',
          feedbackObserved: true
        },
        {
          name: 'approval-once',
          waitingStatus: 'waiting_approval',
          resumedStatus: 'running',
          claimedAction: 'write_file',
          approvalStatus: 'consumed',
          replayError: 'approval_consumed'
        }
      ]
    });
  });
});
