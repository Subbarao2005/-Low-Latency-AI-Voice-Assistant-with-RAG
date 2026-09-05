const { createLead, getLead, updateLead, addNote } = require("./leadActions");
const { createContact, getContact, updateContact } = require("./contactActions");
const { createDeal, getDeal, updateDeal } = require("./dealActions");

const ACTIONS = Object.freeze({
  create_lead: createLead,
  get_lead: getLead,
  update_lead: updateLead,
  add_note: addNote,
  create_contact: createContact,
  get_contact: getContact,
  update_contact: updateContact,
  create_deal: createDeal,
  get_deal: getDeal,
  update_deal: updateDeal,
});

module.exports = { ACTIONS };