import { z } from 'zod'

import { OPERATIONS } from '../contracts/operations.js'

/**
 * `sign_in`, the one tool that is not an operation: it opens a browser window on the user's
 * machine, which the command line and the SDK never do except through `login`, its command line
 * equivalent. It is offered only for a runtime that can sign in (`SignInCapable`), with the
 * `account` toolset, and when `OVERLEAF_ALLOWED_EFFECTS` allows `sign-in`.
 */
export const SIGN_IN_TOOL = {
  name: 'sign_in',
  toolset: 'account',
  effects: ['sign-in'],
  description:
    "Open a browser window on the user's computer for them to sign in to Overleaf, and save the session, as the login command does. Call it only when the user agrees. A session that already works is returned at once and nothing opens. It waits up to 40 seconds: status waiting means the user is still signing in, so call it again only after they say they have finished. After a failure, ask the user before calling it again. Needs Google Chrome, Chromium, Brave, or Microsoft Edge.",
  outputSchema: OPERATIONS.auth_status.outputSchema.partial().extend({
    status: z.enum(['signed_in', 'waiting']),
    alreadySignedIn: z.boolean().optional(),
    deadline: z.string().optional(),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
} as const
