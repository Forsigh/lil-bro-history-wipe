# Store listing

What goes into the Chrome Web Store dashboard, kept here rather than in a folder on someone's
desktop so the suite can check it. Nothing in this directory is shipped in the extension zip.

- `dashboard-paste-en.txt` and `dashboard-paste-pl.txt` — the dashboard fields, one block per
  field, with the field's character limit in the label. Paste field by field.
- `dashboard-fields.md` and `dashboard-fields-pl.md` — the same walkthrough with the reasoning
  alongside each field, for when a field needs explaining rather than pasting.
- `listing.md` — the submission notes: what the store requires, what was decided and why.
- `privacy-policy.html` — a copy of `docs/privacy.html`, the page the listing links to as the
  privacy policy. A test asserts the two are the same file, because a reviewer reads this copy
  and a shopper reads the hosted one.
- `bmc-page.txt` — the support page copy, which is not part of the store submission.

`tests/listing.test.mjs` checks this directory against the package: every permission in
`manifest.json` has a justification and no justification names a permission that is not asked
for, each field fits its limit, the title matches the name in the bundles, and no file here
claims something the code does not do. Two of those checks exist because they failed: a
justification for a permission the extension had stopped using, and a policy paragraph that
said the rule list travelled between machines after the list had moved to local storage.

The release script copies this directory into the store-assets folder on the Desktop, so the
desktop copy is always the one that was checked here.
