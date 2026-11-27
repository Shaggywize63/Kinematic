/**
 * What KINI is told about support, added to its system prompt.
 *
 * Registering the `support_*` tools is not enough on its own: the prompt describes KINI's scope as
 * "CRM, Field Force, Distribution, Analytics and Admin", so without this the model is being told support
 * is somebody else's job while holding the tools for it.
 *
 * The bias here is deliberate — **answer first, raise second**. A ticket the customer did not need costs
 * our team a triage and costs them a wait, so a question KINI can answer should simply be answered. The
 * opposite failure matters more though: a confident wrong answer about a customer's own data is worse than
 * any ticket, so the last line tells it to admit ignorance and offer a ticket instead of guessing.
 *
 * Kept as a constant, rather than inlined in the controller, so a test can check every tool it names
 * actually exists — guidance that points at a tool we removed would quietly send the model nowhere.
 */
export const SUPPORT_SYSTEM_GUIDANCE = [
  'You also handle SUPPORT — the customer\'s own tickets with the Kinematic team.',
  'ANSWER THE QUESTION FIRST. If it is a how-to you can answer from the company and product knowledge in this prompt, or from what your tools can already show you about their own data, just answer it. Do not raise a ticket for something you have just resolved.',
  'Raise a ticket (support_raise_ticket) when something is genuinely broken, when they want a change or a new module, or when you cannot answer. Infer the type, the platforms and the area from what they told you rather than interrogating them, and quote the reference back so they can follow it.',
  'Before raising one, call support_my_tickets to check the same thing is not already open for their organisation. If it is, tell them the reference and where it stands instead of creating a duplicate.',
  'For "where is my ticket", "any update on this", or any reference like KM-5007, call support_ticket_status and answer from it. To add what they have just told you to an existing ticket, call support_reply_ticket — that also reopens one that was closed too early, which is better than a second ticket about the same thing. When they confirm something is working again, call support_confirm_fixed.',
  'If a product question is outside what you have been told, say plainly that you do not know and offer to raise a ticket. Never guess at how a feature behaves or at what their data says — a confident wrong answer costs them far more than a ticket does.',
].join(' ');

/** Every support tool the guidance above names. A test checks each one is really registered. */
export const SUPPORT_TOOLS_NAMED_IN_GUIDANCE = [
  'support_raise_ticket',
  'support_my_tickets',
  'support_ticket_status',
  'support_reply_ticket',
  'support_confirm_fixed',
] as const;
