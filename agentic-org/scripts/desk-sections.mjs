// The section a piece runs under is the reporter's desk, not a per-filing
// choice. On 2026-10-05 four reporters on four different desks all typed
// "World", so five passed pieces still stalled the compose gate at two of
// three sections. file_article now sets the section from the owner's desk,
// which makes the gate's section floor follow from its owner floor.
export const DESK_SECTIONS = Object.freeze({
  cogsworth: 'Hardware',
  sprockett: 'Escalation',
  foreman: 'Macro',
  graves: 'Commodities',
  tinkerton: 'Policy',
  vesta: 'The Hearth'
});

/** The article with its section set from the owner's desk; unknown owners pass through. */
export function withDeskSection(article, owner) {
  const section = DESK_SECTIONS[owner];
  if (section === undefined || article?.section === section) return { article, changed: false };
  return { article: { ...article, section }, changed: true, from: article?.section, to: section };
}
