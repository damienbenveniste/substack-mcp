# LaTeX Discovery

Status: native editor schema mapped; pending live fixture capture and rendering verification.

The current adapter maps `latex_block` to Substack's native `latex_block` node with `persistentExpression` and `id` attributes. The shape was identified from the current authenticated editor schema. It no longer uses a code-block fallback, but it does not satisfy V1's live acceptance criterion until a captured fixture round-trips and the equation renders correctly in the editor and preview.

Markdown input can create this native block with a `latex` fenced block, a `$$` display-math block, or an explicit `:::latex` directive. Fences with any other language, or no language, remain native code blocks.

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

6. Confirm the parsed `draft_body` uses the expected native `latex_block` shape.
7. Run `npm run fixtures:status -- --require-all` and the fixture compatibility test.
8. Adjust `toSubstackProseMirror.ts` only if the captured shape differs from the observed editor schema.

Do not mark V1 complete until a created draft renders a native Substack equation block in the editor and preview.
