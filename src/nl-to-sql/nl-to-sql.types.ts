/** What the model is asked to return for a single question. */
export interface SqlGeneration {
  /** False when the schema cannot answer the question at all. */
  answerable: boolean;
  /** The proposed query; empty string when `answerable` is false. */
  sql: string;
  /** Why this query answers the question, or what is missing if it cannot. */
  explanation: string;
  /** Tables the query reads, as named in the schema. */
  tables: string[];
}

/** One exchange in a conversation: the question and what came back. */
export interface ConversationTurn {
  question: string;
  generation: SqlGeneration;
  askedAt: string;
}

export interface Conversation {
  id: string;
  createdAt: string;
  lastActiveAt: string;
  turns: ConversationTurn[];
}
