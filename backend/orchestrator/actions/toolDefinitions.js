const toolDefinitions = [
  {
    type: "function",
    function: {
      name: "create_lead",
      description: "Create a sales lead. Require a name and phone or email.",
      parameters: {
        type: "object",
        properties: { name: { type: "string" }, phone: { type: "string" }, email: { type: "string" }, company: { type: "string" }, requirement: { type: "string" } },
        required: ["name"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_lead",
      description: "Find a lead by leadId, phone, or email.",
      parameters: { type: "object", properties: { leadId: { type: "string" }, phone: { type: "string" }, email: { type: "string" } }, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "update_lead",
      description: "Update a lead using its leadId.",
      parameters: {
        type: "object",
        properties: { leadId: { type: "string" }, name: { type: "string" }, phone: { type: "string" }, email: { type: "string" }, company: { type: "string" }, requirement: { type: "string" }, status: { type: "string", enum: ["new", "contacted", "qualified", "proposal", "won", "lost"] } },
        required: ["leadId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_note",
      description: "Add a note to a lead.",
      parameters: { type: "object", properties: { leadId: { type: "string" }, note: { type: "string" } }, required: ["leadId", "note"], additionalProperties: false },
    },
  },
];

module.exports = { toolDefinitions };