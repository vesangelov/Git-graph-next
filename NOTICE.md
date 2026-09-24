# Notice on provenance

Git Graph Next is an independent, clean-room implementation. It is **not** a fork
or derivative work of `mhutchie/vscode-git-graph`.

The Git Graph extension by mhutchie is distributed under a licence that grants
permission to use, copy and modify the software, but explicitly withholds
permission to publish or distribute derivative works. For that reason no code,
asset, or markup from that project has been copied, adapted, or consulted while
writing this extension.

What *has* informed this project is the publicly filed feedback in that project's
issue tracker — user-authored descriptions of bugs and desired behaviour. Facts
about how Git itself behaves, and the documented VS Code extension API, are not
subject to that licence.

## Familiar settings

Several settings deliberately use the same names and choices as the Git Graph
extension's — `date.format` with its "Date & Time", "Date Only" and "Relative",
`referenceLabels.alignment`, `openToTheRepoOfTheActiveTextEditorDocument`, and
others — so that someone moving over finds the options they already know where
they expect them. These are the names that extension shows its users in VS
Code's Settings editor and on its Marketplace page: a description of behaviour,
kept the same for familiarity. The code behind every one of them is this
project's own.

Contributors must not copy code from `mhutchie/vscode-git-graph` into this
repository.
