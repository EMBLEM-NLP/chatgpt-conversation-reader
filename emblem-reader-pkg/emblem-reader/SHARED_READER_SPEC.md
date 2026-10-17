# Shared reader release specification

Both focused readers use identical acceptance rules. A successful offline audit is not release approval.

1. Content: captured turn IDs, order, ownership and reply presence must match the transcript. Missing source messages remain explicitly incomplete.
2. Disclosures: each captured activity has a native details/summary parent; nested captured branches remain independently toggleable. Duration alone does not justify an empty dropdown. Capture missing source activity before claiming parity.
3. Images: original viewer open and close fragment targets must resolve. Orphan viewers return to messages. Test rendered image loading, open/close and scroll restoration in an authorized browser.
4. Downloads: compare saved bytes with the source asset hash, including ZIP integrity. Local file existence is only a preflight; browser saved-file evidence is required.
5. Typography: equal viewport, scale, browser, theme and content alignment for source/candidate screenshots. Do not compare differently scaled phone screenshots as equal CSS pixels.
6. Full scroll: known first and last IDs, overlapping frames, stable loading, message coverage and separately expanded branches. Produce paired source/candidate review with unmatched frames retained.
7. Interaction: menu open/close, nested branches, image viewer, copy, download, conversation switching and scroll controls. Live-only actions must not masquerade as connected services.
8. Interoperability: use session.ts for a new supported ChatGPT conversation URL, then import explicit transcript evidence. Selectors and expected message IDs must come from that source. Automatic authenticated URL-to-complete-reader capture is unfinished.
9. Provenance: visible summaries and raw tool inputs/outputs are different records. Never infer payloads from duration or summaries.
10. Release: all source completeness, functional, download and rendered comparison gates must have actual evidence. A loop count or passing unit tests cannot replace missing evidence.

## Offline preflight

`python3 audit-reader.py READER_A.html READER_B.html --asset-root ASSET_ROOT --out audit.json`

The asset root contains the files/ directory. The auditor discovers conversation keys and turn IDs from chat-data rather than hardcoding Mountain or Street. It checks DOM ownership, replies, disclosure presence, fragment targets and all retained asset hashes. Missing assets are separately reported; releaseApproved remains false because offline checks cannot certify browser behavior.

After rebuilding the legacy transcript, run repair-return-links.py before splitting or auditing readers. This repairs target anchors lost during section replacement; it does not reconstruct missing messages or assets.

Use host-capture.ts with an independently authorized pair of already-open Playwright pages for full scroll. The prior candidate-browser restriction remains active here; alternate/headless browser routes must not bypass it.
