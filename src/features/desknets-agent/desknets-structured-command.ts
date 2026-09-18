export const DESKNETS_COMMAND_ACTIONS = [
  "find_availability",
  "select_time",
  "select_candidate",
  "change_duration",
  "change_facility",
  "set_email_notification",
  "show_candidates",
  "confirm_booking",
  "cancel",
  "unknown",
] as const;

export type DeskNetsCommandAction = (typeof DESKNETS_COMMAND_ACTIONS)[number];

export type DeskNetsStructuredCommand = {
  action: DeskNetsCommandAction;
  participants: Array<{ name: string; organization: string | null }>;
  dateStart: string | null;
  dateEnd: string | null;
  startTime: string | null;
  endTime: string | null;
  durationMinutes: number | null;
  candidateNumber: number | null;
  facility: {
    preferred: string | null;
    fallbackLocation: string | null;
    fallbackType: "meeting_room" | "reception_room" | "any" | null;
    anyAvailable: boolean;
  };
  title: string | null;
  sendEmail: boolean | null;
};

const nullableString: JSONSchema = { type: ["string", "null"] };

/**
 * The existing AzureChat tool-calling model acts as the NL analyzer. Keeping
 * the schema beside the DeskNet's integration avoids adding another model
 * request or touching the general chat pipeline.
 */
export const DESKNETS_STRUCTURED_COMMAND_SCHEMA: JSONSchema = {
  type: "object",
  properties: {
    action: { type: "string", enum: [...DESKNETS_COMMAND_ACTIONS] },
    participants: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          organization: nullableString,
        },
        required: ["name", "organization"],
        additionalProperties: false,
      },
    },
    dateStart: nullableString,
    dateEnd: nullableString,
    startTime: nullableString,
    endTime: nullableString,
    durationMinutes: { type: ["integer", "null"] },
    candidateNumber: { type: ["integer", "null"] },
    facility: {
      type: "object",
      properties: {
        preferred: {
          ...nullableString,
          description:
            "Exact preferred facility name, or only the location token for an any-room request. Example: for '有玉のどこかの会議室', use '有玉', never the whole phrase.",
        },
        fallbackLocation: {
          ...nullableString,
          description:
            "Fallback location used only when a distinct preferred facility is unavailable. Do not duplicate preferred for a location-scoped any-room request.",
        },
        fallbackType: {
          type: ["string", "null"],
          enum: ["meeting_room", "reception_room", "any", null],
          description:
            "Requested facility type. For 'どこかの会議室', use meeting_room; for 'どこかの応接室', use reception_room.",
        },
        anyAvailable: {
          type: "boolean",
          description:
            "True when the user permits any available facility within the stated location or fallback scope.",
        },
      },
      required: [
        "preferred",
        "fallbackLocation",
        "fallbackType",
        "anyAvailable",
      ],
      additionalProperties: false,
    },
    title: nullableString,
    sendEmail: { type: ["boolean", "null"] },
  },
  required: [
    "action",
    "participants",
    "dateStart",
    "dateEnd",
    "startTime",
    "endTime",
    "durationMinutes",
    "candidateNumber",
    "facility",
    "title",
    "sendEmail",
  ],
  additionalProperties: false,
};

export function parseDeskNetsStructuredCommand(
  input: string
): DeskNetsStructuredCommand {
  const value = JSON.parse(input) as unknown;
  if (!isRecord(value) || !DESKNETS_COMMAND_ACTIONS.includes(value.action as DeskNetsCommandAction)) {
    throw new TypeError("Invalid DeskNet's command action.");
  }
  if (!Array.isArray(value.participants) || !isRecord(value.facility)) {
    throw new TypeError("Invalid DeskNet's structured command.");
  }
  return value as DeskNetsStructuredCommand;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
import type { JSONSchema } from "openai/lib/jsonschema";
