import { type SessionConfig } from "../../lib/ipc";
import { type OpenEntryResult } from "../../hooks/useWelcomeSessionResume";


export interface PendingSessionAuth {
  kind: "session";
  session: SessionConfig;
  /** Present when the auth wait belongs to a Welcome restore operation. */
  resumeRequestId?: string;
  restoreOperationId?: string;
}


export interface PendingJumpAuth {
  kind: "jump";
  session: SessionConfig;
  jumpSession?: SessionConfig;
  host: string;
  port: number;
  username: string;
  manual: boolean;
  onResolved: (session: SessionConfig) => void;
}


export type PendingAuth = PendingSessionAuth | PendingJumpAuth;


export interface ControlToolDispatch {
  callId: string;
  threadId: string;
  tool: string;
  args: Record<string, unknown>;
}


export type ControlToolExecutor = (dispatch: ControlToolDispatch) => Promise<void>;


export type ConnectQueueOutcome = "opened" | "awaiting-auth" | "awaiting-vault";


/** Connect-queue entry carrying optional Welcome restore context. */
export interface ConnectQueueEntry {
  session: SessionConfig;
  resume?: ResumeQueueContext;
}


export interface ResumeQueueContext {
  requestId: string;
  operationId: string;
  entryIdentity: string;
}


/** A pending Welcome restore entry open, resolved by tab readiness/cancel. */
export interface ResumeWaiter {
  requestId: string;
  operationId: string;
  entryIdentity: string;
  sessionId: string;
  tabId: string | null;
  resolve: (result: OpenEntryResult) => void;
  settled: boolean;
  /** Tabs that already existed when the waiter registered (never bind). */
  excludeTabIds: Set<string>;
  guardTimer: number | null;
}
