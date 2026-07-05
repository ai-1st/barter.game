# barter.game protocol — Voucher post feeds

Nostr-like publishing, anchored to vouchers. An issuer announces "redeem the
package at booth 12"; a holder posts "traded my mug voucher for a great
t-shirt"; a trusted issuer recommends another issuer's voucher. Posts ride the
same machinery as every other document: signed, content-addressed, stored by
banks, verified by readers.

Related: discovery surfaces in [`discovery.md`](./discovery.md); doc model and
signing in [`base.md`](./base.md); RPC methods in
[`bank-rpc.md`](./bank-rpc.md) §2.4.

---

## 1. The Post document

```ts
interface Post extends BaseDoc {
  type: 'post';
  pubkey: Base58PubKey;    // the AUTHOR — any keypair, not just the issuer
  ulid: ULID;              // feed ordering key
  voucher: Base58SHA256;   // the Voucher this post is anchored to
  body_md: string;         // markdown body
  repost?: Base58SHA256;   // hash of another Post being boosted (see §4)
  sig: Base58Signature;    // author's signature
}
```

Posts are ordinary content-addressed docs: canonicalized, hashed, signed by
their author. Every post anchors to exactly one Voucher — the feed is the
voucher's, not the author's. Like all signed docs, a post is irrevocable; what
a bank chooses to *store and serve* is another matter (§5).

## 2. Writing — `submit_docs`, accepted per bank policy

Posts are submitted through the standard `submit_docs` write path. The bank
MUST validate shape, author signature, and that `voucher` resolves to a
Voucher known to this bank (its own, or one whose doc was presented to it —
so any bank the issuer uses can carry the feed); beyond validity,
**acceptance is bank policy** — a
spam filter, an allowlist, a paywall, per-key rate limits, or nothing at all.
A rejected post gets `-32000`; nothing obliges a bank to store any post.

This asymmetry is the spam defense. Everybody can *create* a post linked to
any voucher, but a post only becomes visible where a bank agreed to carry it.
Someone who needs their post noticed must get it accepted by a bank the
issuer's audience actually polls.

## 3. Reading — `list_posts`, filtered by the reader

```ts
list_posts({ voucher: Base58SHA256, author?: Base58PubKey,
             cursor?: string, limit?: number })
→ { items: Post[], next_cursor?: string }

get_post(post_hash) → Post
```

Any caller; newest-first by ULID; paginated (`bank-rpc.md` §2.4,
*Pagination*). The bank returns what it stored — it does not curate for the
reader.

**Visibility is client-side curation.** A reader's client polls the banks the
issuer uses (the voucher's issuing bank first; any further endpoints the
issuer advertises through their Address or profile bundle) and then filters:
show posts whose author is

1. the voucher's issuer, or
2. a pubkey the reader trusts or subscribes to, or
3. reposted (§4) by either of the above.

Everybody can post; only the reader's own trust graph decides what they see.
There is no global timeline and no bank-side ranking.

## 4. Reposts

A post with `repost` set boosts another post: the referenced post gains the
reposter's audience. The canonical use is the issuer amplifying a valuable
holder post to everyone who follows the voucher. A repost MAY carry its own
`body_md` commentary or leave it empty. Clients resolve the referenced hash
via `get_post` (at the same bank first, then any bank the referenced post's
author advertises).

## 5. Moderation

Consistent with the bank openness posture (`README.md` §1.1): validity checks
are protocol, carriage is policy. A bank MAY decline posts at intake, blocklist
an abusive author key, or stop serving a stored post. None of that revokes the
author's signature — a post, once signed, is a fact; the bank only controls
its own distribution of it.

## 6. Future work (non-normative)

Deliberately unspecified in v1, expected to be figured out as real feeds
appear:

- **Replies** — a `reply_to` post-hash field and thread rendering.
- **Embedded media** — images/video, by reference or inline.
- **Embedded documents** — first-class rendering of pubkeys, Vouchers,
  Orders, and other protocol docs inside a post body, so a recommendation can
  carry the thing it recommends.

Extensions MUST be backward-compatible: a v1 client seeing unknown fields
ignores them; a v1 bank stores what validates today.
