# Version 1 Formats and Protocol Contract

This document freezes the version-1 interoperability contract. Protocol, revision, object, and crypto format versions are independent integers and all begin at `1`; an application release number is not a format version.

## Canonical metadata encoding

Protocol metadata is UTF-8 JSON. Values which are hashed or supplied as AEAD associated data are serialized with RFC 8785 JSON Canonicalization Scheme (JCS). Implementations must reject duplicate object member names before or while parsing, arrays where objects are required, inherited or unknown fields, non-safe integers, `NaN`/infinities, invalid Unicode, and noncanonical identifiers. Incoming JSON need not have JCS whitespace or member order unless an endpoint says it is a bound value, but its normalized value must produce one unambiguous JCS encoding.

Large ciphertext is streamed as an HTTP request/response body, not embedded in JSON. JSON metadata requests are at most 8 MiB. Object ciphertext is at most 64 GiB and clients must stream 50 GB files rather than buffer them.

## Identifiers and namespaces

- Vault, device, and revision IDs are lowercase canonical hyphenated UUIDs (36 ASCII characters; RFC 4122 variant, versions 1–8). They are opaque.
- Object IDs and SHA-256 ciphertext checksums are exactly 64 lowercase hexadecimal characters.
- Idempotency keys are 1–128 visible ASCII characters (`0x21`–`0x7e`); spaces and control characters are invalid.
- Object types are `chunk`, `manifest`, and `revision-private`. Storage keys are namespaced as `objects/v1/<type>/<first-two-object-id-characters>/<object-id>`; the type is also authenticated metadata, preventing cross-type substitution.

Chunk IDs are `HMAC-SHA-256(chunk_identifier_key, plaintext_chunk)` and therefore reveal equal chunks within a vault. IDs for randomized encrypted objects are random 256-bit values allocated before encryption. Object IDs are immutable and may never be reused for different bytes or metadata.

## Encrypted object byte format

Files use fixed 4 MiB chunks, recorded as `chunkSize: 4194304` in file metadata. Every non-final chunk is exactly that size; the final chunk is 1 through 4 MiB (an empty file has no chunks). The object record carries object format version, crypto format version, vault ID, object type, object ID, plaintext length, ciphertext length, nonce where randomized, and ciphertext plus GCM tag. SHA-256 covers the complete stored ciphertext envelope bytes.

Object format 1 is exactly one 80-byte header followed by a type-dependent nonce, ciphertext, and a 16-byte GCM tag. There is no padding. Multibyte integers are unsigned big-endian.

| Offset | Width | Field | Version 1 value |
|---:|---:|---|---|
| 0 | 8 | magic | ASCII `NSOBJ001` |
| 8 | 2 | object format | `0x0001` |
| 10 | 2 | crypto format | `0x0001` |
| 12 | 1 | object type | `0x01` chunk, `0x02` manifest, `0x03` revision-private |
| 13 | 1 | nonce length | `0` for chunk; `12` otherwise |
| 14 | 2 | reserved flags | zero; any set bit is invalid |
| 16 | 16 | vault ID | UUID bytes in RFC 4122/network order |
| 32 | 32 | object ID | bytes represented by the 64-hex metadata ID |
| 64 | 8 | plaintext length | exact bytes before AES-GCM |
| 72 | 8 | encrypted payload length | ciphertext bytes excluding nonce and tag |
| 80 | 0 or 12 | nonce | omitted for chunk; physically present otherwise |
| following | encrypted payload length | ciphertext | streamed AES-GCM ciphertext |
| final | 16 | authentication tag | AES-GCM tag |

AES-GCM has no padding, so v1 requires encrypted payload length to equal plaintext length. A chunk frame has no nonce bytes: its nonce is the implied 12 all-zero bytes. Manifest and revision-private frames contain exactly 12 random nonce bytes in the indicated position; an all-zero randomized nonce is syntactically valid but generation must use a CSPRNG. The stored/frame length is exactly `80 + nonceLength + encryptedPayloadLength + 16`. The revision-reference field named `ciphertextLength` means this complete stored frame length, not merely the encrypted-payload field. SHA-256 checksum coverage is every frame byte from magic through the final GCM tag, with no external metadata.

The binary vault UUID must have an RFC 4122 variant and version 1–8 and must equal the request/envelope vault. The 32 object-ID bytes must equal the storage key/reference ID. Object ID is external identity metadata, not a hash of this frame: chunk IDs are the keyed plaintext HMAC; randomized-object IDs are generated as 256 random bits before encryption. Including ID, type, versions, vault, and plaintext length in the exact AAD defined in [security.md](security.md), and requiring header/key equality, binds the frame without a circular ID definition.

Parsers first read exactly 80 bytes, validate magic, versions, type, flags, IDs, nonce rule, and both lengths using unsigned 64-bit arithmetic, then compute the expected total before allocating or consuming the body. The total frame and advertised `ciphertextLength` must not exceed 64 GiB or the lower negotiated limit. Chunk plaintext is 1–4 MiB; randomized-object plaintext is nonempty and bounded by the remaining frame limit. Lengths above JavaScript's safe-integer range are rejected rather than converted. If HTTP `Content-Length` is present it must equal the computed total before body processing. Implementations stream ciphertext through checksum and AEAD processing, require exactly the computed bytes, reject truncation and any trailing byte, and release no plaintext until the tag authenticates (large randomized plaintext may be authenticated into bounded temporary storage). This preserves 50 GB file support as a sequence of bounded 4 MiB frames; no whole file or 64 GiB object is buffered.

Object format `1` supports:

- chunks encrypted with the deterministic construction in [security.md](security.md);
- randomized encrypted manifests containing names and tree/file records;
- randomized `revision-private` payloads containing private revision data.

The revision carries `referenceSetMac = HMAC-SHA-256(revision_authentication_key, ASCII("nanosync/v1/reference-set-mac") || 0x00 || JCS(envelope_without_referenceSetMac))`. This client-authenticated revision content binds all public fields and exact visible references without the impossible circular dependency created by putting a manifest's own ciphertext checksum inside that manifest. On download, clients must verify it before trusting the envelope or decrypting referenced content. The server cannot verify this binding; an authorized publishing client could lie, which is outside server-side confidentiality enforcement.

## Revision envelope

A revision publication contains:

```text
RevisionEnvelope {
  protocolVersion: 1
  revisionFormatVersion: 1
  vaultId, revisionId
  parents: [one or two sorted unique revision IDs]
  creatingDeviceId
  createdAt: canonical YYYY-MM-DDTHH:mm:ss.sssZ
  encryptedManifestObjectId
  references: sorted unique VisibleObjectReference[1..20000]
  referenceSetMac: 64 lowercase hex HMAC
}
VisibleObjectReference {
  objectId, objectType
  ciphertextChecksum
  ciphertextLength: complete frame length; 97..4194400 for chunks, 109..68719476736 otherwise
  objectFormatVersion: 1
}
```

References are sorted lexically by object ID and IDs are unique across types. The manifest ID must identify a `manifest` entry. The list is the canonical server-visible membership and reachability set: before advancing head the server verifies every entry exists with matching type, length, checksum, and format. It is also the GC traversal source. Consequently the server learns exact per-revision object membership, graph changes, equality, types, sizes, and reuse even though paths and contents remain encrypted. This explicit leakage resolves the impossibility of checking references found only inside an encrypted manifest.

Revision `createdAt` is client-provided display metadata, not trusted server time. Normal revisions have one parent and merge revisions two. Vault initialization is a separately authorized operation which creates the genesis revision; its special zero-parent envelope is not accepted by the ordinary parser/publication endpoint.

## Negotiation and limits

Before upload, clients fetch capabilities containing sorted supported protocol, revision-format, object-format, and object-type lists plus effective limits. V1 constants are: 4 MiB chunks; 64 GiB object ciphertext; 20,000 references/revision; two parents; 1,000 IDs/presence query; 1,000 items/page; 8 MiB JSON metadata; and 128-character idempotency keys. A client must not publish an unadvertised version or type. Servers reject unsupported versions, unknown fields, noncanonical ordering, and values above either the fixed format bound or a lower advertised operational bound.

Readers may retain old format support, but must never reinterpret old bytes under a new version. Adding optional fields requires a new protocol/schema version because v1 rejects unknown fields. Object migration creates new immutable objects; it does not mutate existing IDs.

## Publication and idempotency

`advanceHead` supplies protocol version, vault ID, expected revision ID (nullable only for authorized initialization), proposed envelope, and idempotency key. The server stores the first terminal outcome for the authenticated device, operation, and key. Repeating byte-equivalent normalized input returns `alreadyAccepted` after an earlier success or the recorded failure; reuse with different input is rejected. Records must survive crashes for at least the maximum documented client retry window.

Exact JSON result status spellings are `accepted`/`alreadyAccepted` with revision and positive server sequence, `staleHead` with current revision, `missingObjects` with a sorted bounded ID list, or `invalidRevision` with a stable reason code. Object PUT is independently idempotent: the same ID, length, checksum, type, and bytes succeeds as already present; any mismatch is a conflict. Presence requests contain at most 1,000 IDs. Pages contain at most 1,000 records and use opaque cursors.

Server acceptance occurs in an explicit SQLite `BEGIN IMMEDIATE` transaction after object verification. A crash exposes either the old head or the complete new head and idempotency result, never a partial publication.

The v1 revision HTTP contract is:

- `GET /v1/head` returns `{"protocolVersion":1,"status":"head","revisionId":"...","sequence":N}` for an accepted head (`N` is positive), or `{"protocolVersion":1,"status":"initializedWithoutHead","revisionId":null,"sequence":0}` only during the bootstrap interval.
- `GET /v1/revisions/{revisionId}` returns `{"protocolVersion":1,"revision":RevisionEnvelope,"sequence":N|null}`. A null sequence identifies a prepared stale proposal. Cross-vault IDs are indistinguishable from absent IDs.
- `POST /v1/head/advance` requires `application/json`, the 8 MiB metadata limit, and the strict `AdvanceHeadRequest` shape in this section. Its HTTP status is 200 for every typed `AdvanceHeadResult`; malformed transport/protocol input uses a protocol error envelope.

Exact request and result JSON members (with no additional members) are:

```json
{"protocolVersion":1,"vaultId":"<vault UUID>","expectedRevisionId":"<revision UUID>","proposedRevision":{"protocolVersion":1,"revisionFormatVersion":1,"vaultId":"<vault UUID>","revisionId":"<revision UUID>","parents":["<revision UUID>"],"creatingDeviceId":"<device UUID>","createdAt":"2026-01-02T03:04:05.006Z","encryptedManifestObjectId":"<64 lowercase hex>","references":[{"objectId":"<64 lowercase hex>","objectType":"manifest","ciphertextChecksum":"<64 lowercase hex>","ciphertextLength":109,"objectFormatVersion":1}],"referenceSetMac":"<64 lowercase hex>"},"idempotencyKey":"<visible ASCII>"}
```

```text
{"status":"accepted","revisionId":"<revision UUID>","sequence":N}
{"status":"alreadyAccepted","revisionId":"<revision UUID>","sequence":N}
{"status":"staleHead","currentRevisionId":"<revision UUID>"}
{"status":"missingObjects","objectIds":["<sorted object ID>"]}
{"status":"invalidRevision","reasonCode":"<STABLE_CODE>"}
```

`currentRevisionId` can be null only for the initialized-without-head bootstrap interval. Normal publication never permits a null `expectedRevisionId`.

The advance request digest is SHA-256 over JCS of `{expectedRevisionId,proposedRevision,protocolVersion,vaultId}`: the idempotency key alone is excluded. Idempotency is scoped to authenticated principal and device, operation `advance-head-v1`, and key. Accepted and stale outcomes are terminal and atomically recorded; replay of an accepted result is returned as `alreadyAccepted` with the original revision and sequence. `missingObjects` and `invalidRevision` are not recorded, so repair (notably uploading or restoring objects) may safely retry the same key. Key reuse with a different digest is HTTP 409 `IDEMPOTENCY_KEY_REUSE`.

Normal publication rejects null `expectedRevisionId` as `invalidRevision/GENESIS_REQUIRES_BOOTSTRAP`. One-parent revisions must name the expected revision; sorted two-parent merges must include it. Every parent must already be stored in the vault, including a prepared stale proposal where applicable. Before transaction entry the server checks exact catalog metadata and non-failed integrity state, confirms storage existence in batches of at most 1,000, and confirms stored length. The transaction rechecks exact catalog metadata and integrity before inserting or accepting. A stale structurally valid proposal is retained with a null sequence.

Storage itself cannot participate in the SQLite transaction. The object store is operator-exclusive, and no in-process GC exists in v1; future GC must coordinate with metadata transactions and recheck reachability before deletion. External object mutation is outside this contract. The server stores but cannot verify `referenceSetMac`; clients authenticate it. Server sequence and acceptance order are authoritative, while `createdAt` remains display metadata.

## Protocol errors

General API failures use the strict JSON shape `{ protocolVersion: 1, code, message, retryAfterSeconds? }`; no other fields are allowed. `message` is safe public text of 1–512 UTF-8 bytes without control characters and must never contain secrets, SQL/filesystem details, stack traces, credentials, object plaintext, or internal exception text. `retryAfterSeconds`, when present, is a safe integer from 0 through 86,400.

Stable v1 codes are `MALFORMED_REQUEST`, `UNSUPPORTED_PROTOCOL_VERSION`, `UNSUPPORTED_FORMAT_VERSION`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `IDEMPOTENCY_KEY_REUSE`, `BODY_LIMIT_EXCEEDED`, `OBJECT_LIMIT_EXCEEDED`, `REFERENCE_LIMIT_EXCEEDED`, `CHECKSUM_MISMATCH`, `LENGTH_MISMATCH`, `RATE_LIMITED`, `STALE_HEAD`, `MISSING_OBJECTS`, `INVALID_REVISION`, `INTERNAL`, and `UNAVAILABLE`. HTTP status is transport metadata and does not replace this code. Unknown codes or error-envelope fields are rejected by v1 clients. Detailed diagnostics belong only in access-controlled server logs with secret redaction.

## Version 1 object HTTP API

`GET /v1/capabilities` and `GET /v1/health` are public. Health returns only `{"protocolVersion":1,"status":"ok"}` when metadata and object storage are reachable. All routes below require an authenticated context supplied by the server authorization boundary; vault identity comes only from that context and is never selected by request data. Protected object operations require an already-initialized singleton `server_state` row for that exact vault. They never initialize a server or select a different vault.

- `POST /v1/objects/presence` accepts `application/json` with the strict shape `{"protocolVersion":1,"objectType":"chunk|manifest|revision-private","objectIds":[...]}`. The list contains 1–1,000 lexically sorted unique IDs. Its operational body limit is 128 KiB. The response is `{"protocolVersion":1,"objectType":...,"objects":[{"objectId":...,"present":boolean},...]}` in request order. A catalog entry with no storage file is marked missing and reported false.
- `PUT /v1/objects/{objectType}/{objectId}` requires exact headers `Content-Length`, `X-Nanosync-Protocol-Version: 1`, `X-Nanosync-Object-Format-Version: 1`, `X-Nanosync-Ciphertext-SHA256` (64 lowercase hex), and `Idempotency-Key`. `Transfer-Encoding` is rejected. The body is one complete object frame whose header identities and computed length match the authenticated vault, route, and headers. Initial success is `{"protocolVersion":1,"status":"stored"}` (201) or `status:"alreadyPresent"` (200). Idempotency is scoped by principal, device, operation, and key. The request digest binds normalized vault/type/ID/length/checksum/version metadata. A same-request terminal-success replay returns HTTP 200 with the persisted JSON body; the original HTTP status is not persisted. Key reuse with different metadata is `IDEMPOTENCY_KEY_REUSE`. Failures are not recorded. A crash after durable object publication but before catalog/idempotency commit is repaired by retry. After storage has accepted or checksum-verified an exact matching object, the catalog transaction resets prior `missing` or `corrupt` integrity state to `unchecked`; storage conflicts never clear integrity failures. A completed idempotency replay may cancel the unneeded body after request-header validation, and an already-present immutable object may cancel the remaining body after fixed-header validation. Clients must not rely on complete consumption of duplicate upload bodies.
- `GET /v1/objects/{objectType}/{objectId}` first requires an exact catalog type/ID match and then streams `application/octet-stream`. It returns `Content-Length`, `Accept-Ranges: bytes`, `X-Nanosync-Object-Type`, and the protocol/object-format/checksum headers used above. Exactly one RFC byte range is supported: closed (`bytes=0-9`), open-ended (`bytes=10-`), or suffix (`bytes=-10`). HTTP endpoints are inclusive and storage ranges are half-open. A valid range returns 206 and `Content-Range`; malformed, multiple, or unsatisfiable ranges return 416 plus `Content-Range: bytes */size` and a protocol error envelope. A cataloged object missing from storage, or whose stored length disagrees with the catalog, is marked with the corresponding integrity failure and returns 503 `UNAVAILABLE`; only an absent catalog entry returns 404.

Unknown paths return `NOT_FOUND`; unsupported methods return 405 with a protocol error envelope and `Allow`. JSON responses use `application/json; charset=utf-8`. Protected-route authorization failures are always `UNAUTHORIZED`. Unexpected failures expose only generic `INTERNAL` messages.
