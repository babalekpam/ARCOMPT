---
name: EICAR scanner proof
description: A failure mode in tests that prepend document headers to the canonical EICAR sample.
---

Use the exact canonical 68-byte EICAR sample to prove that a ClamAV scanner recognizes test malware. Do not assume that putting the test string after a PDF header is equivalent to an infected PDF: this construction scanned clean while the canonical string was rejected by the same daemon and signatures.

**Why:** Without checking sample bytes and response, an ad hoc "PDF with EICAR inside" test can suggest the scanner is broken or, worse, be mistaken for proof of document-level malware detection.

**How to apply:** Check the exact EICAR sample length and expected signature for a scanner smoke test. Separately test the upload path and a valid malicious-document fixture if document-level detection is required; never present a prefixed text sample as that fixture.