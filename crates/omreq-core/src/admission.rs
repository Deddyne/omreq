//! Client-local application admission. No transport connection counts are
//! inferred from these permits; TCP lifetime has its own acceptance criteria.
//!
//! Queues are FIFO with lazy deletion: cancelling a queued ticket only marks it
//! dead (its entry disappears), and dead slots are skipped when they reach a
//! queue front or compacted once they outnumber live ones. Cancel, grant and
//! register are therefore amortized O(1) per queue, also for mass aborts.
use crate::error::{Error, Result};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{Arc, Mutex, MutexGuard, PoisonError},
};
use tokio::sync::Notify;

/// Lock that survives a panic of another holder. Every critical section here
/// leaves the counters consistent before it can panic, so the state remains
/// usable; refusing it would turn one panic into a failure of every later
/// request and of Drop during garbage collection.
pub(crate) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

struct Entry {
    origin: String,
    global: bool,
    origin_held: bool,
    notify: Arc<Notify>,
    /// Sequence number of this entry's current queue slot; queue slots with
    /// another sequence number are dead.
    seq: u64,
}
/// A queue slot: (ticket id, sequence number).
type Slot = (u64, u64);
#[derive(Default)]
struct Origin {
    active: usize,
    /// Live queued tickets in `fresh` and `handoff`.
    waiting: usize,
    /// Tickets waiting for their first global slot.
    fresh: VecDeque<Slot>,
    /// Admitted tickets that moved here and wait only for this origin.
    handoff: VecDeque<Slot>,
    /// Sequence number of this origin's live slot in `State::ready`; set
    /// exactly when `waiting > 0`.
    ready: Option<u64>,
}
#[derive(Default)]
struct State {
    closed: bool,
    active: usize,
    queued: usize,
    handoffs: usize,
    entries: HashMap<u64, Entry>,
    origins: HashMap<String, Origin>,
    /// Origins with waiting tickets, round robin; may hold dead slots.
    ready: VecDeque<(String, u64)>,
    /// Live slots in `ready`.
    ready_live: usize,
    next_seq: u64,
}
pub(crate) struct Scheduler {
    max_active: usize,
    max_queued: usize,
    max_per_origin: usize,
    state: Mutex<State>,
}
/// One ticket owns the entire operation, including any redirect handoff.
/// Explicit cancellation and Drop both remove it idempotently.
pub(crate) struct Ticket {
    scheduler: Arc<Scheduler>,
    id: u64,
    notify: Arc<Notify>,
}
fn closed() -> Error {
    Error::new("ERR_CLIENT_CLOSED", "queue", "Admission is closed")
}
impl Scheduler {
    pub fn new(max_active: usize, max_queued: usize, max_per_origin: usize) -> Arc<Self> {
        Arc::new(Self {
            max_active,
            max_queued,
            max_per_origin,
            state: Mutex::new(State::default()),
        })
    }
    pub fn register(self: &Arc<Self>, id: u64, origin: String) -> Result<Ticket> {
        let notify = Arc::new(Notify::new());
        let notifications = {
            let mut state = lock(&self.state);
            if state.closed {
                return Err(closed());
            }
            if state.entries.contains_key(&id) {
                return Err(Error::new(
                    "ERR_INVALID_ARGUMENT",
                    "queue",
                    "Duplicate operation admission",
                ));
            }
            let immediate = state.active < self.max_active
                && state
                    .origins
                    .get(&origin)
                    .is_none_or(|o| o.active < self.max_per_origin && o.waiting == 0);
            if !immediate && state.queued >= self.max_queued {
                return Err(Error::new(
                    "ERR_QUEUE_FULL",
                    "queue",
                    "Operation queue is full",
                ));
            }
            state.entries.insert(
                id,
                Entry {
                    origin: origin.clone(),
                    global: false,
                    origin_held: false,
                    notify: notify.clone(),
                    seq: 0,
                },
            );
            state.queued += 1;
            state.enqueue(id, &origin);
            state.dispatch(self.max_active, self.max_per_origin)
        };
        wake(notifications);
        Ok(Ticket {
            scheduler: self.clone(),
            id,
            notify,
        })
    }
    fn cancel(&self, id: u64) {
        let notifications = {
            let mut state = lock(&self.state);
            let Some(entry) = state.entries.remove(&id) else {
                return;
            };
            if entry.global {
                state.active -= 1;
                if !entry.origin_held {
                    state.handoffs -= 1;
                }
            } else {
                state.queued -= 1;
            }
            if entry.origin_held {
                state
                    .origins
                    .get_mut(&entry.origin)
                    .expect("ticket origin")
                    .active -= 1;
            } else {
                // Its queue slot is dead now that the entry is gone.
                state.unqueue(&entry.origin);
            }
            state.cleanup(&entry.origin);
            let mut notifications = vec![entry.notify];
            notifications.extend(state.dispatch(self.max_active, self.max_per_origin));
            notifications
        };
        wake(notifications);
    }
    /// Stop new admission and wake pending waiters without returning slots
    /// still owned by physical sockets. Their tickets release only on Drop.
    pub fn stop(&self) {
        let notifications = {
            let mut state = lock(&self.state);
            state.closed = true;
            state.entries.values().map(|e| e.notify.clone()).collect()
        };
        wake(notifications);
    }
    pub fn stats(&self) -> Value {
        let state = lock(&self.state);
        let mut origins = state.origins.iter().map(|(origin, o)| {
            json!({"origin":origin,"activeOperations":o.active,"waitingOperations":o.waiting})
        }).collect::<Vec<_>>();
        origins.sort_by(|a, b| a["origin"].as_str().cmp(&b["origin"].as_str()));
        json!({"activeOperations":state.active,"queuedOperations":state.queued,
            "originWaitOperations":state.handoffs,
            "origins":origins})
    }
    pub fn counts(&self) -> (usize, usize) {
        let state = lock(&self.state);
        (state.active, state.queued)
    }
    /// Queued tickets that only the global cap holds back: their origin still
    /// has room under the per-origin cap. Freeing global capacity elsewhere
    /// helps exactly these.
    pub fn globally_blocked(&self) -> usize {
        let state = lock(&self.state);
        if state.active < self.max_active {
            return 0;
        }
        state
            .origins
            .values()
            .map(|o| o.waiting.min(self.max_per_origin.saturating_sub(o.active)))
            .sum()
    }
    /// Origins that currently hold or wait for a slot. An origin absent from
    /// this set has no operation that could be using one of its connections.
    pub fn busy_origins(&self) -> HashSet<String> {
        let state = lock(&self.state);
        state.origins.keys().cloned().collect()
    }
}
/// Whether a queue slot still belongs to a waiting ticket.
fn live(entries: &HashMap<u64, Entry>, (id, seq): Slot) -> bool {
    entries
        .get(&id)
        .is_some_and(|e| e.seq == seq && !e.origin_held)
}
/// Drop dead slots at the front, so the front (if any) is live.
fn prune(queue: &mut VecDeque<Slot>, entries: &HashMap<u64, Entry>) {
    while queue.front().is_some_and(|slot| !live(entries, *slot)) {
        queue.pop_front();
    }
}
impl State {
    fn sequence(&mut self) -> u64 {
        self.next_seq += 1;
        self.next_seq
    }
    fn enqueue(&mut self, id: u64, key: &str) {
        let seq = self.sequence();
        let ready = self.sequence();
        let entry = self.entries.get_mut(&id).expect("queued entry");
        entry.seq = seq;
        let handoff = entry.global;
        let origin = self.origins.entry(key.to_string()).or_default();
        if handoff {
            origin.handoff.push_back((id, seq));
        } else {
            origin.fresh.push_back((id, seq));
        }
        origin.waiting += 1;
        if origin.ready.is_none() {
            origin.ready = Some(ready);
            self.ready.push_back((key.to_string(), ready));
            self.ready_live += 1;
        }
    }
    /// One queued ticket of `key` left without being granted.
    fn unqueue(&mut self, key: &str) {
        let origin = self.origins.get_mut(key).expect("ticket origin");
        origin.waiting -= 1;
        if origin.waiting == 0 {
            self.unready(key);
        } else if origin.fresh.len() + origin.handoff.len() > 2 * origin.waiting + 16 {
            let entries = &self.entries;
            origin.fresh.retain(|slot| live(entries, *slot));
            origin.handoff.retain(|slot| live(entries, *slot));
        }
    }
    /// `key` has no waiting ticket left: drop its queues and ready slot.
    fn unready(&mut self, key: &str) {
        let origin = self.origins.get_mut(key).expect("ready origin record");
        origin.fresh.clear();
        origin.handoff.clear();
        if origin.ready.take().is_some() {
            self.ready_live -= 1;
        }
        if self.ready_live == 0 {
            self.ready.clear();
        } else if self.ready.len() > 2 * self.ready_live + 16 {
            let origins = &self.origins;
            self.ready
                .retain(|(key, seq)| origins.get(key).is_some_and(|o| o.ready == Some(*seq)));
        }
    }
    fn cleanup(&mut self, key: &str) {
        if self
            .origins
            .get(key)
            .is_some_and(|o| o.waiting == 0 && o.active == 0)
        {
            self.origins.remove(key);
        }
    }
    fn dispatch(&mut self, max_active: usize, max_per_origin: usize) -> Vec<Arc<Notify>> {
        let mut notifications = Vec::new();
        if self.closed {
            return notifications;
        }
        loop {
            // No fresh request is eligible when all global slots are held.
            // Avoid walking a large queue on every fresh registration in the
            // common saturated case; only admitted handoffs can progress.
            if self.active >= max_active && self.handoffs == 0 {
                break;
            }
            let turns = self.ready.len();
            let mut progress = false;
            for _ in 0..turns {
                let (key, ready) = self.ready.pop_front().expect("ready origin");
                let Some(origin) = self.origins.get_mut(&key) else {
                    continue;
                };
                if origin.ready != Some(ready) {
                    continue;
                }
                prune(&mut origin.fresh, &self.entries);
                prune(&mut origin.handoff, &self.entries);
                // FIFO among eligible operations. With all global slots held,
                // a fresh request cannot block an already-admitted redirect:
                // doing so would deadlock a one-slot A -> B chain behind B.
                let fresh = origin.fresh.front().map(|slot| slot.1);
                let handoff = origin.handoff.front().map(|slot| slot.1);
                let candidate = if origin.active >= max_per_origin {
                    None
                } else if self.active < max_active {
                    match (fresh, handoff) {
                        (Some(f), Some(h)) if h < f => origin.handoff.pop_front(),
                        (Some(_), _) => origin.fresh.pop_front(),
                        (None, _) => origin.handoff.pop_front(),
                    }
                } else {
                    origin.handoff.pop_front()
                };
                if let Some((id, _)) = candidate {
                    let entry = self.entries.get_mut(&id).expect("queued entry");
                    origin.active += 1;
                    origin.waiting -= 1;
                    entry.origin_held = true;
                    if !entry.global {
                        entry.global = true;
                        self.active += 1;
                        self.queued -= 1;
                    } else {
                        self.handoffs -= 1;
                    }
                    notifications.push(entry.notify.clone());
                    progress = true;
                }
                if origin.waiting > 0 {
                    self.ready.push_back((key, ready));
                } else {
                    self.unready(&key);
                }
                if progress {
                    break;
                }
            }
            if !progress {
                break;
            }
        }
        notifications
    }
}
impl Ticket {
    pub async fn wait(&self) -> Result<()> {
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            {
                let state = lock(&self.scheduler.state);
                if state.closed {
                    return Err(closed());
                }
                let Some(entry) = state.entries.get(&self.id) else {
                    return Err(closed());
                };
                if entry.origin_held {
                    return Ok(());
                }
            }
            notified.await;
        }
    }
    pub fn move_to(&self, next: String) -> Result<()> {
        let notifications = {
            let mut state = lock(&self.scheduler.state);
            if state.closed {
                return Err(closed());
            }
            let entry = state.entries.get_mut(&self.id).ok_or_else(closed)?;
            if !entry.global || !entry.origin_held {
                return Err(Error::new(
                    "ERR_INVALID_ARGUMENT",
                    "queue",
                    "Origin handoff requires admission",
                ));
            }
            if entry.origin == next {
                return Ok(());
            }
            let previous = std::mem::replace(&mut entry.origin, next.clone());
            entry.origin_held = false;
            state.handoffs += 1;
            state
                .origins
                .get_mut(&previous)
                .expect("previous origin")
                .active -= 1;
            state.cleanup(&previous);
            state.enqueue(self.id, &next);
            state.dispatch(self.scheduler.max_active, self.scheduler.max_per_origin)
        };
        wake(notifications);
        Ok(())
    }
    pub fn cancel(&self) {
        self.scheduler.cancel(self.id);
    }
}
impl Drop for Ticket {
    fn drop(&mut self) {
        self.cancel();
    }
}
fn wake(notifications: Vec<Arc<Notify>>) {
    for notify in notifications {
        notify.notify_waiters();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    fn ticket(s: &Arc<Scheduler>, id: u64, origin: &str) -> Ticket {
        s.register(id, origin.into()).unwrap()
    }
    fn granted(ticket: &Ticket) -> bool {
        ticket.scheduler.state.lock().unwrap().entries[&ticket.id].origin_held
    }
    fn empty(s: &Scheduler) {
        let state = s.state.lock().unwrap();
        assert_eq!(state.active, 0);
        assert_eq!(state.queued, 0);
        assert!(state.entries.is_empty());
        assert!(state.origins.is_empty());
        assert!(state.ready.is_empty());
        assert_eq!(state.ready_live, 0);
    }
    fn consistent(s: &Scheduler) {
        use std::collections::HashSet;
        let state = s.state.lock().unwrap();
        assert!(state.active <= s.max_active && state.queued <= s.max_queued);
        assert_eq!(
            state.active,
            state.entries.values().filter(|e| e.global).count()
        );
        assert_eq!(
            state.queued,
            state.entries.values().filter(|e| !e.global).count()
        );
        assert_eq!(
            state.handoffs,
            state
                .entries
                .values()
                .filter(|e| e.global && !e.origin_held)
                .count()
        );
        let ready = state
            .ready
            .iter()
            .filter(|(key, seq)| {
                state
                    .origins
                    .get(key)
                    .is_some_and(|o| o.ready == Some(*seq))
            })
            .map(|(key, _)| key)
            .collect::<Vec<_>>();
        assert_eq!(ready.len(), state.ready_live);
        let ready = ready.into_iter().collect::<HashSet<_>>();
        assert_eq!(ready.len(), state.ready_live);
        let mut queued = HashSet::new();
        for (key, origin) in &state.origins {
            assert!(origin.active <= s.max_per_origin);
            assert!(origin.active > 0 || origin.waiting > 0);
            assert_eq!(ready.contains(key), origin.waiting > 0);
            assert_eq!(origin.ready.is_some(), origin.waiting > 0);
            assert_eq!(
                origin.active,
                state
                    .entries
                    .values()
                    .filter(|e| e.origin == *key && e.origin_held)
                    .count()
            );
            let mut waiting = 0;
            for (slots, handoff) in [(&origin.fresh, false), (&origin.handoff, true)] {
                for &slot in slots {
                    if !live(&state.entries, slot) {
                        continue;
                    }
                    waiting += 1;
                    assert!(queued.insert(slot.0));
                    let entry = &state.entries[&slot.0];
                    assert_eq!(&entry.origin, key);
                    assert_eq!(entry.global, handoff);
                }
                // Dead slots never outnumber live ones by more than the slack.
                assert!(slots.len() <= 2 * origin.waiting + 17);
            }
            assert_eq!(waiting, origin.waiting);
        }
        assert_eq!(queued.len(), state.queued + state.handoffs);
        assert!(state.ready.len() <= 2 * state.ready_live + 17);
        for entry in state.entries.values() {
            assert!(state.origins.contains_key(&entry.origin));
        }
    }
    #[tokio::test]
    async fn fifo_registration_precedes_task_polling_and_cancellation_unlinks() {
        let s = Scheduler::new(1, 8, 1);
        let first = ticket(&s, 1, "a");
        let second = ticket(&s, 2, "a");
        let third = ticket(&s, 3, "a");
        assert!(granted(&first));
        assert!(!granted(&second));
        drop(first);
        assert!(granted(&second));
        assert!(
            tokio::time::timeout(Duration::from_millis(5), third.wait())
                .await
                .is_err()
        );
        drop(second);
        third.wait().await.unwrap();
        drop(third);
        empty(&s);
    }
    #[test]
    fn blocked_origin_cannot_reserve_other_global_slots_and_queue_limit_is_exact() {
        let s = Scheduler::new(4, 1, 1);
        let a = ticket(&s, 1, "a");
        let a2 = ticket(&s, 2, "a");
        assert_eq!(
            s.register(3, "a".into()).err().unwrap().code,
            "ERR_QUEUE_FULL"
        );
        let b = ticket(&s, 4, "b");
        assert!(granted(&a) && granted(&b));
        assert!(!granted(&a2));
        assert_eq!(s.stats()["activeOperations"], 2);
        assert_eq!(s.stats()["queuedOperations"], 1);
        a2.cancel();
        a2.cancel();
        let a3 = ticket(&s, 5, "a");
        drop(a);
        assert!(granted(&a3));
        drop((a2, a3, b));
        empty(&s);
    }
    #[test]
    fn eligible_origins_alternate_and_each_origin_is_fifo() {
        let s = Scheduler::new(1, 8, 1);
        let blocker = ticket(&s, 1, "blocker");
        let a1 = ticket(&s, 2, "a");
        let a2 = ticket(&s, 3, "a");
        let a3 = ticket(&s, 4, "a");
        let b1 = ticket(&s, 5, "b");
        let b2 = ticket(&s, 6, "b");
        drop(blocker);
        assert!(granted(&a1));
        drop(a1);
        assert!(granted(&b1));
        assert!(!granted(&a2));
        drop(b1);
        assert!(granted(&a2));
        drop(a2);
        assert!(granted(&b2));
        drop(b2);
        assert!(granted(&a3));
        drop(a3);
        empty(&s);
    }
    #[test]
    fn one_slot_redirect_bypasses_a_fresh_request_that_needs_its_global_slot() {
        let s = Scheduler::new(1, 1, 1);
        let a = ticket(&s, 1, "a");
        let b = ticket(&s, 2, "b");
        a.move_to("b".into()).unwrap();
        assert!(granted(&a));
        assert!(!granted(&b));
        assert_eq!(s.stats()["activeOperations"], 1);
        assert_eq!(s.stats()["queuedOperations"], 1);
        drop(a);
        assert!(granted(&b));
        drop(b);
        empty(&s);
    }
    #[test]
    fn crossing_redirects_release_origin_before_waiting_and_hold_global() {
        let s = Scheduler::new(2, 4, 1);
        let a = ticket(&s, 1, "a");
        let b = ticket(&s, 2, "b");
        a.move_to("b".into()).unwrap();
        assert!(!granted(&a));
        assert_eq!(s.stats()["originWaitOperations"], 1);
        assert_eq!(s.stats()["activeOperations"], 2);
        b.move_to("a".into()).unwrap();
        assert!(granted(&a) && granted(&b));
        assert_eq!(s.stats()["originWaitOperations"], 0);
        drop((a, b));
        empty(&s);
    }
    #[tokio::test]
    async fn close_wakes_waiters_and_releases_all_metadata() {
        let s = Scheduler::new(1, 1, 1);
        let a = ticket(&s, 1, "a");
        let b = ticket(&s, 2, "a");
        let wait = b.wait();
        let close = async {
            tokio::task::yield_now().await;
            s.stop();
        };
        let (result, ()) = tokio::join!(wait, close);
        assert_eq!(result.unwrap_err().code, "ERR_CLIENT_CLOSED");
        assert!(s.register(3, "a".into()).is_err());
        drop((a, b));
        empty(&s);
    }
    #[test]
    fn many_distinct_origins_and_cancellations_leave_no_cache() {
        let s = Scheduler::new(1, 1, 1);
        for id in 1..=10000 {
            let a = ticket(&s, id * 2, &format!("origin-{id}"));
            let b = ticket(&s, id * 2 + 1, &format!("origin-{id}"));
            b.cancel();
            drop((a, b));
            empty(&s);
        }
    }
    #[test]
    fn deterministic_state_sequences_keep_permits_queues_and_counters_consistent() {
        let s = Scheduler::new(4, 8, 2);
        let mut tickets = Vec::<Ticket>::new();
        let mut seed = 0x2545f4914f6cdd1du64;
        let mut id = 0;
        for _ in 0..10000 {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            match seed % 3 {
                0 => {
                    id += 1;
                    match s.register(id, format!("origin-{}", seed % 7)) {
                        Ok(ticket) => tickets.push(ticket),
                        Err(error) => assert_eq!(error.code, "ERR_QUEUE_FULL"),
                    }
                }
                1 if !tickets.is_empty() => {
                    drop(tickets.swap_remove(seed as usize % tickets.len()));
                }
                2 if !tickets.is_empty() => {
                    let ticket = &tickets[seed as usize % tickets.len()];
                    let was_granted = granted(ticket);
                    let result = ticket.move_to(format!("origin-{}", (seed >> 8) % 7));
                    assert_eq!(result.is_ok(), was_granted);
                }
                _ => {}
            }
            consistent(&s);
        }
        s.stop();
        consistent(&s);
        drop(tickets);
        empty(&s);
    }
    #[test]
    fn mass_abort_of_queued_tickets_is_linear_and_keeps_fifo() {
        let s = Scheduler::new(1, 400_000, 1);
        let blocker = ticket(&s, 0, "a");
        let n = 200_000u64;
        let tickets = (1..=n).map(|id| ticket(&s, id, "a")).collect::<Vec<_>>();
        let survivor = ticket(&s, n + 1, "a");
        let started = std::time::Instant::now();
        // Cancelling from the front and from the back are both linear overall.
        let (front, back) = tickets.split_at(tickets.len() / 2);
        for t in front {
            t.cancel();
        }
        for t in back.iter().rev() {
            t.cancel();
        }
        assert!(
            started.elapsed() < std::time::Duration::from_secs(5),
            "quadratic cancellation"
        );
        consistent(&s);
        assert_eq!(s.stats()["origins"][0]["waitingOperations"], 1);
        drop(blocker);
        assert!(granted(&survivor));
        drop((tickets, survivor));
        empty(&s);
    }
    #[test]
    fn many_waiting_origins_cancel_without_rescanning_the_ready_list() {
        let s = Scheduler::new(1, 400_000, 1);
        let blocker = ticket(&s, 0, "blocker");
        let tickets = (1..=100_000u64)
            .map(|id| ticket(&s, id, &format!("origin-{id}")))
            .collect::<Vec<_>>();
        let started = std::time::Instant::now();
        for t in tickets.iter().rev() {
            t.cancel();
        }
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
        consistent(&s);
        let late = ticket(&s, 200_000, "late");
        drop(blocker);
        assert!(granted(&late));
        drop((tickets, late));
        empty(&s);
    }
    #[test]
    fn fresh_and_handoff_tickets_of_one_origin_are_granted_in_arrival_order() {
        let s = Scheduler::new(3, 8, 1);
        let b = ticket(&s, 1, "b");
        let a = ticket(&s, 2, "a");
        let fresh = ticket(&s, 3, "b");
        // `a` is admitted and redirects to b after the fresh request queued.
        a.move_to("b".into()).unwrap();
        assert!(!granted(&fresh) && !granted(&a));
        drop(b);
        assert!(granted(&fresh), "the earlier fresh request goes first");
        assert!(!granted(&a));
        drop(fresh);
        assert!(granted(&a));
        consistent(&s);
        drop(a);
        empty(&s);
    }
}
