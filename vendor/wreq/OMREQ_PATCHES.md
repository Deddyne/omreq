# Omreq transport backport

Base: published wreq 0.16.3, VCS 6073cf683d0a62c49c6d9ab4dc8a3c4727e953f0.
The additional optional
`trust_anchors` and `grease_sigalgs_enabled` fields and connector application
come from upstream cd76bcdf1307153de289d34e072528bdf0510a3b. Their defaults
remain None. All original source is Apache-2.0, with LICENSE retained.

Omreq also adds optional physical socket hooks through TCP creation/connector
configuration. Each address-race attempt reserves before Socket::new and owns
its reservation through raw socket drop. The hook can wake pending connect,
read and write polls during close. When installed, pool checkout cancels a
losing connect instead of spawning it as detached work. No observer preserves
the upstream behavior. See the exact changed files and patch in the manifest;
these hooks do not infer idle counts from HTTP2 pool entries.
The inner cancelled-request replay switch is exposed separately: the outer
retry policy does not control that loop. Omreq explicitly disables both.

See ../../patches/transport.json for provenance, companion pinned TLS crates,
reason and removal condition. This is an internal qualification candidate;
it is not a claim of verified Chrome support.
