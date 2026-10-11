import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerGate } from "./lib/register.js";

export default definePluginEntry({
  id: "glpi-ticket-gate-gen12",
  name: "GLPI Ticket Gate (gen12)",
  description: "Shadow-only GLPI ticket preflight and evidence gate. Never blocks tool execution.",
  register: registerGate,
});
