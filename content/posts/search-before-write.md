---
title: "Do Not Load the Whole Past into the Model"
date: 2026-09-26T20:20:00+09:00
draft: false
tags: ["agents", "memory"]
summary: "Why the record of truth stays separate from the memory retrieved for a model, and why create versus update is decided only after search."
math: false
---

# Do Not Load the Whole Past into the Model

If the model could see the whole past, a new event would obviously be either new or a continuation of something that already exists. The input cannot carry that premise. The record grows. The window fills first with rows that barely relate. Decide to create before searching, and the same task gets another row. Decide to update before searching, and a row that did not match gets rewritten.

This design separates the record of truth from the memory that is searched and handed over. The model's input is only the slice retrieved for that moment. Whether a new event becomes a create or an update is decided after memory is searched.

## The problem

The record of truth is the task row, the event row, and the person row. If that disappears, the task disappears. The prose handed to the model is not a copy of it. Make the copy the source of truth, and paraphrase, truncation, and a bad write become the task itself.

A new event can be read either way. It might be a first request. It might be a note on yesterday's task. It might be a completion report. It might be small talk that is not a task. Choose the operation from the wording alone, and duplicates and wrong updates come out of the same input.

Search has holes too. The row just written is not in the index yet. An empty index is not the same as an empty world. Read empty as "new," and the second message in the same thread becomes another task. Read empty as "cannot decide" and stop processing, and index lag becomes silence.

Folding memory into a single summary takes a different pressure. Stack unprocessed events into one call, and the call grows and fails more easily. Stop the cursor at the failed position, and the next round makes the same chunk larger still. Leaving it stopped freezes the stream. Fill the failed part with plausible prose, and a history that never happened sits next to the record of truth.

Reading every open task on every turn works while there are few. As they grow, unrelated rows push out the one row that matched. Read everything first, and the reason to search disappears.

## Constraints

The constraints in this design are as follows.

Creates and updates against the record of truth are only operations that come after memory was searched. The wording of a new event does not yet carry a kind of operation.

What is handed to the model is the slice that was searched. The full set, the full text, and the full history of the record are not handed over. The number of queries has a cap, and so does the length of each slice. What exceeds the cap is not quietly appended at the tail.

An empty search is not proof that nothing exists. A bounded standby set may be passed separately from the record. The standby is limited to recent rows and to person rows related to that event. It is not a reread of everything. The operation is decided after the searched slices and that standby have been seen.

A row just written inside the same thread does not wait for the index. The record is read directly by identity of origin. That is not adding history in place of search. Only the rows inside that thread are seen.

A summary is a kind of memory. It is not the record of truth. It is not a queue that delivers tasks. A summary failure does not delete a row of the record. A failed chunk is not filled with invented prose. After the retry cap, the cursor moves past that chunk. There is no way back after it moves. That is why the summary does not carry a delivery guarantee for any individual task.

Prose the model wrote does not replace the body of the record. Search results are input. Writing back is a create, an update, or a do-nothing against a row of the record.

## Approaches this design rejects

### Concatenating history into the input

Stacking unprocessed events, open tasks, and the list of people into one input. While it is small, it looks simpler than search. As it grows, position inside the window decides the result. The one related row falls far from the new event. If the same call is both the summary and the operation, a summary failure becomes an operation failure. This design does not expand the record into the input.

### Reading every open task first

Loading every incomplete task before search. The intent is to prevent duplicates, and the effect is to fill the input with unrelated titles. Hand over a long text, such as a meeting, at the same time, and the incomplete list crowds the text until the commitment at the tail is no longer visible. Fix the amount read up front, and an old important row loses to a new thin one. The design went back to searching, then handing over.

### Deciding create or update from the wording alone

Deciding create or update at the moment the new event is read, and only then looking for a matching row. Search after a create decision is only a duplicate check. Search after an update decision goes looking for a row that fits the operation already chosen. In neither case does search decide the operation. Falling through to create when the search was empty turns a hole in the index into a new row. In this design, the kind of operation is written only after the search results are in hand.

### Making the summary the record of truth

Making one piece of prose the past of the workspace itself. A person can read it, and it is easy to hand to a model. A summary is incomplete, though. Where it truncates is decided by the model's window and by a call that failed. Treat that prose as the task row, and a commitment that was not summarized never existed. If a person edits that prose and the model rewrites the same prose, the last write decides the past. In this design, a summary stays one slice that may be handed over. Whether a task exists is decided only by a row of the record.

### Making a document per record and using the collection as input

Projecting each row of the record into a document the model reads, and expanding the collection on every judgment. Names change. Bake a path into the input, and a rename breaks old references. Hand over the whole collection every time, and you are back to the same window problem as concatenated history. Write that prose back into the record, and the model's paraphrase becomes the body of the task. This design does not make the projected document the record. Reading is either search or an explicit read of one item.

### Treating a failed search as nothing found

Making a failed query, a result cut by the cap, and a lagging index all the same "no match." No match sits close to "you may create." A failure is only something that was not seen. This design does not make failure, empty, and cut-by-cap the same success. On empty, the bounded standby is added, and the operation is still decided after it has been seen. An operation is not settled while the search is in failure.

### Waiting until the index catches up

Stopping the next event until the previous row appears in search. Index lag becomes task lag. The second message in the same thread has a known origin. There is nothing to wait for inside that thread. The wait stays only on external search. The same thread reads the record directly.

## The shape that was adopted

Memory is split into three layers. Rows of the record, slices retrieved and handed over, and the decision of an operation.

### The record stays as rows

Tasks, events, and people are each their own rows. A copy expanded into the model's input at one moment is not treated as the latest. Deleting a row, updating a row, and creating a row are operations on the record. They are not appends onto a search result.

The processing that updates a summary does not rewrite these rows. If the summary call fails, the rows remain. A chunk past the retry cap advances the cursor without contributing to the summary. That gap is a missing summary. It is not a missing task. An unclassified failure does not advance the cursor. An unknown failure does not discard the range that was being watched.

### Only the searched slice is handed over

The input to a judgment is the slice searched for that event. Queries are planned after the event has been seen. They are not a fixed "every incomplete task." The number of queries has a cap. One event does not fan out into questions that are too broad.

Each slice is cut short. A title, a state, a due date, and the head of the body are enough. The full body is not repeated once per candidate. Searched slices are placed ahead of the standby. That avoids the standby filling the window and dropping the one row that matched.

When a summary is handed over, it is a slice too. There is no guarantee of the full text. When a row of the record and the summary disagree, the row is believed.

Even when the reading side holds several documents, that collection is not expanded into the input. A list, a search, and a read of one item take only what is needed. If some processing depends on a particular document, that document is read by name. Handing over the collection together is not a substitute for that name.

### Create or update is decided after the slices

A new event has no operation until search finishes. If the matched row is a continuation of the same task, the operation is an update. If no row matches and it stands as a request, the operation is a create. A report, a backchannel, or a repeat of something already finished is do-nothing. The three are choices after seeing the same input.

An update is performed only against a row that search made visible. An identifier is not filled in by guessing from the wording. A row that was not seen cannot be the target of an update. A create is what remains after do-nothing has been considered. An empty search alone is not a create. Create happens only once the standby has also been seen and there is still no matching row.

A row just created in the same thread is passed, in addition to the searched slices, by matching origin. The second message looks at that row and then chooses update or do-nothing. Even if the index is behind, it does not fall through into another create.

When one event touches several tasks, the operations are written separately. Unrelated commitments are not mixed into one create. Each operation records which slice it used as evidence. An update with no evidence is not executed.

### The record is written only after the decision

The decision is one of create, update, or do-nothing. Do-nothing is not a failure. Do-nothing because an existing row matched, and do-nothing because it is not a task, are kept apart. The first points at the matched row. The second points at no row.

Writing writes to a row of the record. It does not write to a searched slice. It does not write to the summary. Prose the model returned is not substituted wholesale as the body of the task. An update may change only the fields the decision named.

## What this makes possible

As the past grows, the input to a judgment stays a slice. Search, not position in the window, decides which row is shown. Unrelated incomplete tasks do not push out a new commitment.

The same event is sometimes a create and sometimes an update. Which one it is is decided after search. Similar wording alone does not add a new row. A row that was not seen is not updated.

The previous row is visible inside the same thread without waiting for the index. The second message does not become another task.

If the summary fails, the task rows remain. The summary does not freeze and keep refusing later events. What did not enter the summary remains a gap in the summary. It does not become a gap in the record.

Fold the record and the memory you search and hand over into one thing, and paraphrase, truncation, index lag, and deciding the operation too early all act on the same prose at once. They were split so that a task remains even when memory is missing, and so that what was visible can be kept before a task is written.
