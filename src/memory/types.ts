/**
 * The unit of memory is a *turn* (one user message + the answer it got), not a
 * message. Questions like "what did I ask you on 3 November?" are questions
 * about exchanges, and claims attach to an answer, not to a sentence.
 */
export interface Turn {
  id: string;
  sessionId: string;
  /** ISO timestamp of when the user asked. */
  ts: string;
  user: string;
  assistant: string;
  /** Sources the answer was grounded in, numbered as they were cited. */
  sources: Source[];
  /** One-line gist, written by the background enricher. Used for cheap recall. */
  summary?: string;
  /** Proper nouns worth matching on later ("HubSpot", "Neon", "Postgres"). */
  entities?: string[];
  /** Whether the background enricher has run yet. */
  enriched?: boolean;
  /** True for rows inserted by `npm run seed` so the agent can flag demo data. */
  seeded?: boolean;
}

export interface Source {
  n: number;
  url: string;
  title: string;
  publishedAt?: string;
}

/**
 * A checkable statement the agent made. This is what turns "has anything
 * changed since Monday?" from a vague re-search into a diff with a known
 * baseline: we stored the old value, where it came from, and when.
 */
export interface Claim {
  id: string;
  turnId: string;
  sessionId: string;
  /** When the claim was made (not when the fact became true). */
  ts: string;
  /** "HubSpot Sales Hub Professional" */
  subject: string;
  /** "price per seat per month" */
  attribute: string;
  /** "$100" — kept as free text; normalising currency/units loses nuance. */
  value: string;
  sourceUrl?: string;
  sourceTitle?: string;
  /** Last time this claim was confirmed against the live web. */
  lastCheckedAt?: string;
  lastCheckResult?: 'unchanged' | 'changed' | 'unverifiable';
}

export interface VerificationResult {
  claim: Claim;
  status: 'unchanged' | 'changed' | 'unverifiable';
  currentValue?: string;
  evidenceUrl?: string;
  evidenceTitle?: string;
  note?: string;
}

export type StoreEvent =
  | { op: 'turn'; turn: Turn }
  | { op: 'patch'; id: string; fields: Partial<Turn> }
  | { op: 'claim'; claim: Claim }
  | { op: 'claim-patch'; id: string; fields: Partial<Claim> };
