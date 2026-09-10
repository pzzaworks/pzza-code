export interface AppArgumentSchema {
  type: string;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  items?: AppArgumentSchema;
  minProperties?: number;
  properties?: Record<string, AppArgumentSchema>;
  required?: string[];
  additionalProperties?: false;
}
export interface AppCommandSchema extends AppArgumentSchema {
  description: string;
  type: "object";
  properties: Record<string, AppArgumentSchema>;
  required: string[];
  additionalProperties: false;
}
export const APP_COMMANDS: Record<string, AppCommandSchema>;
export function validateAppCommand(action: string, args: Record<string, unknown>): Record<string, unknown>;
