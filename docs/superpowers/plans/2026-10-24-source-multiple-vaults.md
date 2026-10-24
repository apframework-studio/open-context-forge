# One source in multiple knowledge bases

1. Add a source-to-vault membership table and migrate existing single-vault records without changing the files in any vault.
2. Allow filing an imported source into another vault, keep the first filing as the legacy reference, and expose all memberships in source list and batch responses.
3. Make vault filters, knowledge listings, and confirmed analysis synchronization read all memberships.
4. Move vault selection and analysis generation into row operations. Show source text on expansion, compact original link plus domain, and a status pill for analysis.
5. Verify migration, second-vault filing, filtering, analysis synchronization, and the source workbench UI.

Source filing is one-way in the source workbench: users may add more vaults, but cannot remove an imported association there. Removing an indexed source belongs to a separate knowledge-base operation that also addresses the vault file and indexes.
