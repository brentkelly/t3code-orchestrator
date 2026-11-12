# Mentioning cards

Type `@` in a thread's composer, or in a card's brief, and the board's cards are offered first
when the text matches one. Match a card by its key (`T3O-58`, `t3o-5`), by its number alone
(`58`), or by words from its title once you have typed three characters. Cards from the thread's
own project come first, then the newest. Picking one inserts a chip: the card's key in its
project's colour, then its title. Click the chip to open the card.

## What the agent sees

The agent gets the card's key, title and id, and is told to read the card with `board_get_card`.
The brief is never pasted into the prompt, so the agent always reads the card as it is now. A
thread on a machine that cannot reach the board still has the key and title to go on.

## Briefs

A brief accepts the same mentions as the composer: `@` for cards, threads, machines, models and
files, `$` for skills and `/` for provider commands. Skills and commands come from every provider
enabled on the board server, each naming the providers that have it. An agent reading the brief
sees each mention as a Markdown link carrying its label and id.

Files are searched in the project's checkout on the board server. When the board runs on a
server with no checkout of the project, `@` offers no files there.

A brief is edited as plain text, so Markdown, comments and spacing are saved exactly as written.

## Small print

- A message holding nothing but a card chip counts as empty and does not send. Add a word.
- The mobile app shows a sent card mention as its key and title, but has no card search.
