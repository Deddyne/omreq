# Omreq protocol backports

Base: published wreq-proto 0.2.3. Original source and LICENSE are retained.
`patches/vendor-manifest.json` pins the published and effective source files;
`patches/wreq-proto-0.2.3.patch` contains every change.

The HTTP2 adapter forwards Omreq's per-connection smaller-only HPACK Huffman
policy to the pinned HTTP2 implementation. The upstream default is unchanged.

When an HTTP1 response receiver has been cancelled, its dispatcher now returns
the cancellation error immediately. Waiting to flush an abandoned request body
can block indefinitely when a server has paused reads. Dropping the dispatcher
instead drops its upload body, buffers and raw socket. Native upload task guards
and paused-server cancellation tests verify the lifetime; ordinary keep-alive,
early responses and exact Chrome request-wire comparisons are requalified too.

The HTTP2 dispatcher watches request cancellation while peer stream capacity is
exhausted. It moves existing channel entries into a FIFO in cooperative batches,
registers all cancellation callbacks and removes cancelled pending-open bodies.
Only the cancelled stream is reset. Omreq admission bounds the combined request
ownership; the queue does not copy bodies or create extra requests/tasks.

Reasons, regression coverage and removal criteria are in `patches/transport.json`.
