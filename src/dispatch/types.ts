import type { AgentCard, Fealty } from '../a2a/types.js';

export type VassalLike = {
  name: string;
  taskUrl: string;
  card: AgentCard;
  fealty: Fealty;
};
