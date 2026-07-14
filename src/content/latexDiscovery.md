# LaTeX Discovery

Status: pending live Substack fixture capture.

The current adapter maps `latex_block` to a `code_block` with `lang: "latex"` and returns a warning. This is a development fallback only. It does not satisfy V1's native LaTeX acceptance criterion.

Required discovery flow:

1. Create a new long-form Article draft manually in Substack.
2. Add a LaTeX equation block through the Substack editor.
3. Enter:

   ```latex
   E = mc^2
   ```

4. Save the draft.
5. Run:

   ```bash
   npm run inspect:draft -- <draft_id> --fixture latex-block
   ```

6. Inspect the parsed `draft_body` JSON.
7. Update `toSubstackProseMirror.ts` so `LatexBlock` emits the observed native node shape.
8. Add a fixture-based regression test.

Do not mark V1 complete until a created draft renders a native Substack equation block in the editor and preview.
