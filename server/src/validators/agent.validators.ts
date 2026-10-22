import { z } from 'zod';

export const chatRequestSchema = z.object({
  conversationId: z.string().optional(),
  message: z.string().min(1).max(4000),
  useRag: z.boolean().optional(),
  injectionScheme: z.enum(['pre-user', 'static']).optional(),
  // Eval-only (requires AGENT_EVAL_OPTIONS=true): switch the retrieval
  // strategy for this request ('vector' | 'structured' | 'auto').
  retrievalMode: z.enum(['vector', 'structured', 'auto']).optional(),
});

export const conversationIdParamSchema = z.object({
  id: z.string().min(1),
});

export type ChatRequestInput = z.infer<typeof chatRequestSchema>;
