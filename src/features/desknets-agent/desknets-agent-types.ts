import type { DeskNetsStructuredCommand } from "./desknets-structured-command";

export type DeskNetsAgentMode = "read" | "write";

export type DeskNetsAgentRunStatus =
  | "queued"
  | "running"
  | "awaiting_user_input"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

export type DeskNetsAgentRunRequest = {
  userId: string;
  userEmail?: string;
  threadId: string;
  site: "desknets";
  mode: DeskNetsAgentMode;
  prompt: string;
  conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>;
  structuredCommand?: DeskNetsStructuredCommand;
};

export type DeskNetsApprovalRequest = {
  title: string;
  start: string;
  end: string;
  participantIds: string[];
  facilityId: string;
  emailNotificationWillBeSent: boolean;
};

export type DeskNetsManualActionRequest = DeskNetsApprovalRequest & {
  selfNotificationSuppressed: false;
};

export type DeskNetsAgentRunResponse = {
  webMeetingAdded?: boolean;
  queue?: { waitingPosition?: number; activeCount?: number; waitingCount?: number; capacity?: number };
  intentSource?: string;
  task?: { type: string };
  id?: string;
  runId?: string;
  status: DeskNetsAgentRunStatus | string;
  message?: string;
  error?: string;
  currentUrl?: string;
  screenshotUrl?: string;
  sessionId?: string;
  candidates?: unknown[];
  result?: {
    assistantMessage?: string;
    summary?: string;
    approvalRequest?: DeskNetsApprovalRequest;
    manualActionRequest?: DeskNetsManualActionRequest;
    booking?: {
      title: string;
      start: string;
      end: string;
      participantIds: string[];
      facilityId: string;
      emailNotificationConfigured: boolean;
      verified: boolean;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
};
