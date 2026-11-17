# Verifying my own draft in a fresh turn

A reporter who writes in one turn and files in the next opens this file in the
second turn. That turn starts from a `daimon_continue` note: I wrote the draft
earlier and I do not remember how. I read it the way an outside checker would,
against the rows, and I check two things only: facts and completeness. The
voice is already decided; I do not rewrite it.

## What I read

The note names three files under `drafts/`: `<article id>.json` (the article
exactly as `mcp_validation_validate_article` takes it), `<article id>.rows`
(the evidence rows the draft uses, one per line: story file and row) and
`<article id>.brief` (edition, revision, format and what the assignment asks).
I read those, the assignment record the brief names, and the story files the
rows name. Nothing else: no style guide, no memory, no other story.

## The check

For each sentence, headline and deck first, I write one line to
`drafts/<article id>.check`: its first words, the row that states it and
`ok`, `fix` or `cut`. A sentence is `ok` only when a listed row states it:

- names, offices, numbers, dates, times and order exactly as the row has them,
  with no first name, title or detail the row lacks;
- no more than the row says: no cause, contrast or motive it lacks, nothing
  planned told as done, its qualifiers kept;
- a claim from an unchecked or attributed row is attributed, and never carries
  the headline, deck or lede on its own.

Then completeness: the core development the assignment names is in the piece,
and each thing it asks for is either in or plainly beyond the rows. A supported
fact that is missing and matters goes in as one sentence beside the fact it
belongs to.

## The edits

The fewest words that make a failing sentence true: correct the word, add the
attribution, or cut the sentence. A sentence that is `ok` stays exactly as it
is. I do not reorder, retitle or restyle; headline, deck, lede and ending change
only when they fail, and then as little as possible. After a cut I read the
sentences on either side once, so the paragraph still joins. Each edit goes in
the check file as before, after, row and reason. No failing sentence means no
edit, and that is a good outcome.

## Filing

I write the corrected article back to `drafts/<article id>.json`, validate it
with `mcp_validation_validate_article`, fix only what the validator names, and
file it with `mcp_newsroom_file_article` with this turn's wake id as
`event_key`. Then I do what my AGENTS.md says after a successful filing, mark
the continuation delivery complete and end the turn.

If the rows support nothing the assignment needs, I file nothing, say so in
`room:assignment` and complete the delivery. I never hand the draft on to
another continuation.
