# Claude Notebook - a TermIAu plugin

A notebook per task - the panel's repository and branch - where Claude writes, as it
works, what you would otherwise only find buried in the conversation:

- **Decisions** it took on its own, that the request doesn't cover or departs from:
  what, why, the alternative it discarded and where it lives in the code.
- **Open questions** it couldn't settle and you (or someone you ask) have to answer.
- **Findings** about how the code or the product behaves, confirmed or not.
- **Reports** at the end of each piece of work: what was done, in bullet points.
- **Milestones**: the stages of the work, each with its subtasks - a plan you and
  Claude share. You add milestones and subtasks and check them in the notebook, Claude
  checks them as it finishes them.

Every item's text is Markdown, and a ` ```mermaid ` block in it is drawn as a diagram:
Claude is told to use one whenever a flow explains something better than prose.

Claude learns how to write in it at the start of every session (`termiau send
termiau.claude-notes`), and is told when the task already has a notebook. A task
spanning several sessions keeps a single notebook.

On each panel's bar, a button with the notebook and how many items of each kind are
still open - lit while something of that kind waits for you - opens the notebook beside
the terminal, sharing the panel with it (drag the border between them), one tab per
kind. A button on the notebook makes it float over the terminal instead. **Done** settles
an item and takes it off the count; click a status to change it, delete what no longer
matters. **⌘⇧N** opens every task's notebook, to
revisit or delete old ones.

Everything stays on this machine, in the plugin's storage; nothing goes into the
repository. Needs the Claude Code plugin, which the marketplace installs along with it.
