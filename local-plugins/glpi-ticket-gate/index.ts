import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerGate } from "./lib/register.js";

export default definePluginEntry({
  id: "glpi-ticket-gate",
  name: "GLPI Ticket Gate",
  description: "Shadow-only GLPI ticket preflight and evidence gate. Never blocks tool execution.",
  register: registerGate,
});
