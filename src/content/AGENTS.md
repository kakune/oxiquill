# AGENTS.md

## MDX Authoring

- This directory is reserved for Starlight documentation pages and examples.
- The skeleton keeps only the content tree. Do not add real notes, examples, or migrated prose unless the migration task explicitly asks for content.
- English pages belong under `src/content/docs`. Japanese translations belong under `src/content/docs/ja` with matching slugs.
- Public images, PDFs, and similar unprocessed media belong in `public/media` and should be referenced from MDX with `/media/...` URLs once content exists.

## Interactive Cells

- Interactive Rust and Python cell conventions will be migrated with the runtime implementation.
- Do not add executable cell examples before the runtime extraction and browser execution code is present.

## Validation

- During the skeleton phase, validate the directory layout rather than running docs checks as acceptance gates.
