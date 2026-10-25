// Fingerprint tier: session-level matching of protected facts.
//
// Per-call exact match misses a leak spread over several calls ("the lowest score was 61" in one
// email, "that was Avery" in another). This tier pools, for each record, all session text going to
// recipients not authorized for that record. It flags the record if the pool contains one of its
// identifiers