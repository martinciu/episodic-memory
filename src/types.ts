export interface ToolCall {
  id: string;
  exchangeId: string;
  toolName: string;
  toolInput?: any;
  toolResult?: string;
  isError: boolean;
  timestamp: string;
}

export type ConversationHarness = 'claude' | 'codex';

export interface ConversationExchange {
  id: string;
  project: string;
  timestamp: string;
  userMessage: string;
  assistantMessage: string;
  archivePath: string;
  lineStart: number;
  lineEnd: number;

  // Conversation structure
  parentUuid?: string;
  isSidechain?: boolean;

  // Session context
  harness?: ConversationHarness;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  claudeVersion?: string;
  agentVersion?: string;
  model?: string;
  modelProvider?: string;

  // Thinking metadata
  thinkingLevel?: string;
  thinkingDisabled?: boolean;
  thinkingTriggers?: string; // JSON array

  // Tool calls (populated separately)
  toolCalls?: ToolCall[];
}

export interface SearchResult {
  exchange: ConversationExchange;
  // Absent for text-LIKE hits ('text' mode, and text-origin rows in 'both'):
  // those are never scored against the query embedding (#18).
  similarity?: number;
  snippet: string;
}

export interface MultiConceptResult {
  exchange: ConversationExchange;
  snippet: string;
  conceptSimilarities: number[];
  averageSimilarity: number;
}
