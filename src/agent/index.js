/**
 * Public surface of the agent layer.
 *
 * Note what is absent: any AI provider, any HTTP client, any API key handling.
 * The layer is a contract plus one deterministic local implementation. That is
 * the intended state until the local MVP is stable.
 */

export {
  AGENT_INTENTS,
  DEFAULT_PLAN_LIMIT,
  MAX_PLAN_LIMIT,
  createAgentContext,
  validatePlan,
  assertResolver,
  runAgentRequest,
} from './protocol.js';

export { createLocalResolver, parseTimeWindow, parseLimit } from './local.js';
