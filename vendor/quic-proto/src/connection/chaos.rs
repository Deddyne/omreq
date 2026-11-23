//! Chromium-style chaos protection for client Initial packets.
//!
//! Chromium's QUIC stack (QUICHE) randomizes the layout of the ClientHello in its Initial
//! packets so that middleboxes must reassemble the CRYPTO stream instead of reading the
//! first packet: `QuicPacketCreator::MultiPacketChaosProtect` puts the head and the tail of a
//! ClientHello that spans several packets into the first one, and `QuicChaosProtector` then
//! splits each packet's CRYPTO data into random fragments, adds PING frames, spreads the
//! padding between frames and shuffles them. This module reproduces both steps.

use std::collections::VecDeque;

use bytes::BufMut;
use rand::{RngExt, rngs::StdRng};
use tracing::trace;

use super::stats::FrameStats;
use crate::{coding::BufMutExt, frame, frame::FrameType};

/// The shortest first CRYPTO frame of a multi-packet ClientHello, covering the fixed
/// ClientHello header and the length of the first extension.
const MIN_FIRST_FRAME_LENGTH: usize = 55;
const FIRST_FRAME_LENGTH_RANDOM: u64 = 32;
const MIN_ADDED_CRYPTO_FRAMES: u64 = 2;
const MAX_ADDED_CRYPTO_FRAMES: u64 = 10;
const MIN_ADDED_PING_FRAMES: u64 = 2;
const MAX_ADDED_PING_FRAMES: u64 = 10;

enum Item {
    Crypto(frame::Crypto),
    Ping,
    Padding(usize),
}

fn varint_len(value: u64) -> usize {
    match value {
        0..0x40 => 1,
        0x40..0x4000 => 2,
        0x4000..0x4000_0000 => 4,
        _ => 8,
    }
}

/// `QuicFramer::GetMinCryptoFrameSize`: frame type, offset and length.
fn overhead(offset: u64, length: usize) -> usize {
    1 + varint_len(offset) + varint_len(length as u64)
}

fn random_below(rng: &mut StdRng, bound: u64) -> u64 {
    if bound <= 1 { 0 } else { rng.random_range(0..bound) }
}

/// Fills the rest of a client Initial packet, `buf[..max_size]`, with the pending CRYPTO data
/// that fits, PING and PADDING frames in Chromium's randomized layout.
///
/// Returns the CRYPTO data written, for retransmission, as the frames it was taken in before
/// the random split: like QUICHE, where the chaos protector works on a copy of the queued
/// frames, a lost packet is resent from those and split afresh, so retransmissions do not
/// fragment further with every loss. When nothing is pending, writes nothing and returns an
/// empty list.
pub(super) fn write_crypto(
    pending: &mut VecDeque<frame::Crypto>,
    rng: &mut StdRng,
    buf: &mut Vec<u8>,
    max_size: usize,
    stats: &mut FrameStats,
) -> Vec<frame::Crypto> {
    let free = max_size.saturating_sub(buf.len());
    let mut frames = Vec::new();
    if pending.is_empty() || free <= frame::Crypto::SIZE_BOUND {
        return frames;
    }

    // Multi-packet layout of a fresh ClientHello: the first packet takes its head and its tail,
    // the middle goes into the following packets.
    if let Some(split) = multi_packet_split(pending.front().expect("checked"), free, rng) {
        let mut whole = pending.pop_front().expect("checked");
        let total = whole.data.len();
        let (head, tail) = split;
        let tail_data = whole.data.split_off(total - tail);
        let head_data = whole.data.split_to(head);
        pending.push_front(frame::Crypto {
            offset: head as u64,
            data: whole.data,
        });
        frames.push(frame::Crypto {
            offset: 0,
            data: head_data,
        });
        frames.push(frame::Crypto {
            offset: (total - tail) as u64,
            data: tail_data,
        });
    } else {
        // Sequential fill, as QUICHE's GenerateRemainingCryptoFrames does.
        let mut left = free;
        while let Some(mut next) = pending.pop_front() {
            let head = overhead(next.offset, next.data.len());
            if left <= head {
                pending.push_front(next);
                break;
            }
            let mut length = next.data.len().min(left - head);
            // A shorter frame may encode its length in fewer bytes; never exceed the room.
            while length > 0 && overhead(next.offset, length) + length > left {
                length -= 1;
            }
            if length == 0 {
                pending.push_front(next);
                break;
            }
            let data = next.data.split_to(length);
            left -= overhead(next.offset, length) + length;
            frames.push(frame::Crypto {
                offset: next.offset,
                data,
            });
            if !next.data.is_empty() {
                next.offset += length as u64;
                pending.push_front(next);
                break;
            }
        }
    }

    let used = frames
        .iter()
        .map(|f| overhead(f.offset, f.data.len()) + f.data.len())
        .sum::<usize>();
    let unsplit = frames.clone();
    let mut padding = free - used;
    let mut items: Vec<Item> = frames.iter().cloned().map(Item::Crypto).collect();
    if padding > 0 {
        split_crypto_frames(&mut items, &mut padding, rng);
        add_ping_frames(&mut items, &mut padding, rng, stats);
        spread_padding(&mut items, &mut padding, rng);
        for i in (1..items.len()).rev() {
            let j = random_below(rng, i as u64 + 1) as usize;
            items.swap(i, j);
        }
    }

    for item in items {
        match item {
            Item::Crypto(frame) => {
                trace!("CRYPTO: off {} len {} (chaos)", frame.offset, frame.data.len());
                frame.encode(buf);
                stats.crypto += 1;
            }
            Item::Ping => buf.write(FrameType::PING),
            Item::Padding(n) => buf.put_bytes(0, n),
        }
    }
    debug_assert_eq!(buf.len(), max_size, "chaos layout must fill the packet");
    unsplit
}

/// Head and tail lengths for the first packet of a ClientHello that needs several packets,
/// following `QuicPacketCreator::MultiPacketChaosProtect`.
fn multi_packet_split(
    front: &frame::Crypto,
    free: usize,
    rng: &mut StdRng,
) -> Option<(usize, usize)> {
    if front.offset != 0 {
        return None;
    }
    let total = front.data.len();
    let min_frame = overhead(total.saturating_sub(1) as u64, total);
    if free < 2 * min_frame {
        return None;
    }
    let max_first = free - 2 * min_frame;
    // Later Initial packets carry the same header, so they have the same room.
    let max_other = free - min_frame;
    if total <= max_first {
        return None;
    }
    let occupied = max_other - max_first;
    let packets = (total + occupied).div_ceil(max_other);
    let in_other = (total + occupied).div_ceil(packets);
    if in_other < occupied {
        return None;
    }
    let in_first = in_other - occupied;
    let head = MIN_FIRST_FRAME_LENGTH + random_below(rng, FIRST_FRAME_LENGTH_RANDOM) as usize;
    if total <= head || in_first <= head {
        return None;
    }
    Some((head, in_first - head))
}

/// `QuicChaosProtector::SplitCryptoFrame`.
fn split_crypto_frames(items: &mut Vec<Item>, padding: &mut usize, rng: &mut StdRng) {
    let (start, end) = items.iter().fold((u64::MAX, 0u64), |(start, end), item| match item {
        Item::Crypto(f) => (start.min(f.offset), end.max(f.offset + f.data.len() as u64)),
        _ => (start, end),
    });
    if start == u64::MAX {
        return;
    }
    let max_added_overhead = overhead(end, (end - start) as usize);
    let attempts = MIN_ADDED_CRYPTO_FRAMES
        + random_below(rng, MAX_ADDED_CRYPTO_FRAMES + 1 - MIN_ADDED_CRYPTO_FRAMES);
    for _ in 0..attempts {
        if *padding < max_added_overhead {
            break;
        }
        let index = random_below(rng, items.len() as u64) as usize;
        let Item::Crypto(frame) = &mut items[index] else {
            continue;
        };
        let length = frame.data.len();
        if length <= 1 {
            continue;
        }
        let old_overhead = overhead(frame.offset, length);
        let keep = 1 + random_below(rng, length as u64 - 1) as usize;
        let rest = frame.data.split_off(keep);
        let rest_offset = frame.offset + keep as u64;
        let new_overhead = overhead(frame.offset, keep) + overhead(rest_offset, rest.len());
        items.push(Item::Crypto(frame::Crypto {
            offset: rest_offset,
            data: rest,
        }));
        *padding = (*padding + old_overhead).saturating_sub(new_overhead);
    }
}

/// `QuicChaosProtector::AddPingFrames`.
fn add_ping_frames(
    items: &mut Vec<Item>,
    padding: &mut usize,
    rng: &mut StdRng,
    stats: &mut FrameStats,
) {
    if *padding == 0 {
        return;
    }
    let count = (MIN_ADDED_PING_FRAMES
        + random_below(rng, MAX_ADDED_PING_FRAMES + 1 - MIN_ADDED_PING_FRAMES))
        .min(*padding as u64) as usize;
    items.extend((0..count).map(|_| Item::Ping));
    stats.ping += count as u64;
    *padding -= count;
}

/// `QuicChaosProtector::SpreadPadding`.
fn spread_padding(items: &mut Vec<Item>, padding: &mut usize, rng: &mut StdRng) {
    let mut spread = Vec::with_capacity(items.len() * 2 + 1);
    for item in items.drain(..) {
        let bytes = random_below(rng, *padding as u64 + 1) as usize;
        if bytes > 0 {
            spread.push(Item::Padding(bytes));
            *padding -= bytes;
        }
        spread.push(item);
    }
    if *padding > 0 {
        spread.push(Item::Padding(*padding));
        *padding = 0;
    }
    *items = spread;
}

#[cfg(test)]
mod tests {
    use super::*;
    use bytes::Bytes;
    use rand::SeedableRng;

    fn layout(total: usize, free: usize, seed: u64) -> (Vec<frame::Crypto>, Vec<frame::Crypto>) {
        let mut pending = VecDeque::from([frame::Crypto {
            offset: 0,
            data: Bytes::from((0..total).map(|i| i as u8).collect::<Vec<_>>()),
        }]);
        let mut rng = StdRng::seed_from_u64(seed);
        let mut stats = FrameStats::default();
        let mut first_buf = Vec::new();
        let first = write_crypto(&mut pending, &mut rng, &mut first_buf, free, &mut stats);
        assert_eq!(first_buf.len(), free);
        let mut second_buf = Vec::new();
        let second = write_crypto(&mut pending, &mut rng, &mut second_buf, free, &mut stats);
        assert_eq!(second_buf.len(), free);
        assert!(pending.is_empty(), "two packets carry the ClientHello");
        (first, second)
    }

    #[test]
    fn multi_packet_layout_covers_the_client_hello_once() {
        for seed in 0..64 {
            let (first, second) = layout(1874, 1210, seed);
            // The first packet holds the head and the tail of the ClientHello.
            assert!(first.iter().any(|f| f.offset == 0));
            assert!(first.iter().any(|f| f.offset + f.data.len() as u64 == 1874));
            let head = first
                .iter()
                .filter(|f| f.offset < 100)
                .map(|f| f.offset + f.data.len() as u64)
                .max()
                .unwrap();
            assert!((55..87).contains(&head), "head length {head}");
            let mut ranges = first
                .iter()
                .chain(&second)
                .map(|f| (f.offset, f.offset + f.data.len() as u64))
                .collect::<Vec<_>>();
            ranges.sort();
            let mut next = 0;
            for (start, end) in ranges {
                assert_eq!(start, next, "contiguous, non-overlapping ranges");
                next = end;
            }
            assert_eq!(next, 1874);
            for f in first.iter().chain(&second) {
                assert_eq!(f.data[0], f.offset as u8, "fragment data follows its offset");
            }
        }
    }

    #[test]
    fn retransmission_keeps_the_unsplit_frames() {
        for seed in 0..64 {
            let (first, second) = layout(1874, 1210, seed);
            // Head and tail in the first packet, the middle in one frame in the second.
            assert_eq!(first.len(), 2);
            assert_eq!(first[0].offset, 0);
            assert_eq!(first[1].offset + first[1].data.len() as u64, 1874);
            assert_eq!(second.len(), 1);
            // Resending the first packet splits head and tail once more, not its fragments.
            let mut pending = VecDeque::from(first.clone());
            let mut rng = StdRng::seed_from_u64(seed + 1000);
            let mut buf = Vec::new();
            let mut stats = FrameStats::default();
            let resent = write_crypto(&mut pending, &mut rng, &mut buf, 1210, &mut stats);
            assert!(pending.is_empty());
            assert_eq!(buf.len(), 1210);
            assert_eq!(resent.len(), 2);
            assert!(stats.crypto <= 2 + MAX_ADDED_CRYPTO_FRAMES);
        }
    }

    #[test]
    fn single_packet_layout_adds_pings_and_padding() {
        let mut pending = VecDeque::from([frame::Crypto {
            offset: 0,
            data: Bytes::from(vec![1; 600]),
        }]);
        let mut rng = StdRng::seed_from_u64(7);
        let mut buf = Vec::new();
        let mut stats = FrameStats::default();
        let frames = write_crypto(&mut pending, &mut rng, &mut buf, 1210, &mut stats);
        assert!(pending.is_empty());
        assert_eq!(buf.len(), 1210);
        assert_eq!(frames.iter().map(|f| f.data.len()).sum::<usize>(), 600);
        assert_eq!(frames.len(), 1, "retransmissions keep the unsplit frame");
        assert!(stats.crypto >= 2, "the CRYPTO frame was split on the wire");
        assert!(stats.ping >= 2);
    }
}
