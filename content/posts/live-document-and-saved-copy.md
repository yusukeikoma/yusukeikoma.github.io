---
title: "Separate the Live Document from the Saved Copy"
date: 2026-09-26T20:50:00+09:00
draft: false
tags: ["collaboration", "documents"]
summary: "Why the live document merges without conflict while it is open, why the save is a separate copy, and why an empty document is neither shown nor written before sync finishes."
math: false
---

# Separate the Live Document from the Saved Copy

If one person opens a document and saves after they finish writing, the thing being edited and the save can be the same thing. They split when several people open it at once, each person's input reaches the others, and someone who opens it later reads what was saved. Make the saved row the source of truth for editing, and whoever writes later erases the earlier input. Write the empty document from the moment it was opened as the source of truth, and the blank from before sync finishes erases contents that were already there. The path that delivers an update to people who have it open, and the save that is read back after a crash, fail under different conditions.

In this design, the thing that exists while the document is open is a document that merges without conflict. The save places a copy of that document separately. Before sync finishes, an empty document is not shown, and it is not written while empty. An update is delivered to every connection that has that document open.

## The problem

When two people have it open at once, they contend for one saved row. If each local side writes the full text back, the later write overwrites the earlier edit. If one side fails to save, it remains on that person's machine and is absent from the document the next person opens.

The local document just after open is empty. Show that empty as it is, and the reader thinks the document was empty. Type into it, and an edit that started from empty merges with contents that were already there. The merge can come out close to empty. Even if it is not shown, saving that empty underneath replaces the saved contents with a blank. Do this when the sync peer is unreachable, and the empty on the side that could not reach erases the document the other side held.

Distribute updates through the save, and a person who has it open does not see the other person's input until the save finishes. A slow save looks like slow editing. A failed save looks like a failed edit. What you want to see is whether an update arrived between the open connections, not whether a copy remained.

The other way, holding the document only in memory and having no save, the result of the merge disappears the moment the process dies. Rebuild from plain text, and structure, and a merge that has not yet fallen into plain text, drop out. Rebuild from plain text every time, and the state of the people who had it open and the state of the next person who opens it become different documents.

Remove someone who cannot write from the connection, and that person does not see updates while it is open. Allow the connection and also let that person's updates reach the save, and a permission that cannot write becomes a hole on the save side. Seeing and writing are different facts on the same connection.

A disconnect happens in the middle of the wait for the last save. Rely only on the wait, and input from just after close does not remain in the copy. Remove the wait and save on every input, and the save becomes the editing path again.

## Constraints

The constraints in this design are as follows.

The source of truth for collaborative editing is the document in the memory of the side that owns sync. Each document has one name, and connections that have that name open see the same in-memory document. The merge happens there. It does not happen on the saved row.

The save is a separate operation. An encoded state and a plain-text copy are written after a short wait from the last change. Sync processing does not wait for the save to finish. Delivery to open connections does not wait on whether the save succeeded.

A document is not saved before sync finishes. The same holds when closing, and when leaving the place. An empty local document must not be written to the source of truth in place of a sync that did not arrive.

How it is shown is split too. When an encoded state is already held, it is applied to the document before the connection, and the first paint is not empty. When it is not held, the plain-text copy is shown until sync finishes, and an empty collaborative surface is not presented as the document. Only a document that is truly empty, with no copy, is visible as empty.

An update is sent to every connection that has that document open. It is not enough to deliver it to someone who comes to fetch after it has been saved.

A connection that cannot write still receives updates if it is open. An update that came from that connection is dropped. A dropped update is not allowed to reach the in-memory document, or the save.

An encoded state is built once from the plain-text copy only when no encoded state exists yet. A document that has state is not rebuilt from plain text every time it is opened.

On disconnect, the in-memory document is saved even in the middle of the wait. A save failure is recorded, and the editing connection is not cut because of that failure.

## Approaches this design rejects

### Making the saved row the source of truth

People who have it open write the full text back to the saved row. The later write overwrites the earlier edit. Even if several people have it open, the other person's input is invisible until the row is read again. The save also resolves conflicts, so the slowness of the save and the correctness of the edit become the same thing.

The plain-text copy is kept so that someone who does not have it open can read it, and so it can be shown before sync. It is not the substrate of the merge.

### Showing an empty editing surface before sync

Showing an empty editing surface as the document until the connection finishes. The reader thinks it was empty. Input, or an automatic save, makes that empty the source of truth. When the sync peer is unreachable, this save replaces contents that were there with a blank.

Painting empty before applying an encoded state that is already held is the same. State that is held is applied before the connection. Only when it is not held is the plain-text copy shown instead. Empty is only when there is neither a copy nor state.

Showing, and not writing, are separate guards. Hide the empty, and a save underneath still erases. Until sync finishes, every save path is stopped.

### Making the save and delivery the same write

Saving on every input, and having other people come read the save. An update on an open connection waits for a save round trip. If the save fails, it does not arrive on the other person's side either. Having been able to edit, and a copy remaining, become the same success.

In this design, an update is sent to open connections at the moment it is applied to the in-memory document. The save happens separately, after a short wait. Even if the save is late, the document visible to people who have it open is not late. Even if the save fails, the open document remains.

### Locking so that only one person writes

Making everyone else read-only while it is open. Overwrites do not happen. Simultaneous editing does not happen either. What should be delivered is that the input of everyone who has it open merges into the same document, and that result is visible to all of them. A lock avoids that problem.

Removing someone who cannot write from the connection was also rejected. Remove them, and that person does not see updates while it is open. The connection is allowed. Only applying their update is dropped. What was dropped does not reach the save either.

### Rebuilding from plain text after a crash

Not keeping an encoded state, and building the document from the plain-text copy after the process dies. Structure that does not fall into plain text, and a merge newer than the copy, disappear. The next person who opens it sees a different document from the people who had it open before the crash.

Only a document that has never had state is built once from plain text. After that, the source of truth is the encoded state. It is not returned to plain text every time it is opened.

## The shape that was adopted

There are two documents. The in-memory document while it is open, and the save for someone who reads later. The name is one per document, and a connection attaches to that name.

<img src="/images/live-document-copy.en.svg" alt="After sync, the live document is copied to the saved copy. Empty is not written before sync." width="410" style="max-width:100%;height:auto;">

### Do not show empty until sync finishes

The local side builds the document before the connection. If an encoded state has already been received, it is applied before the connection. The first thing visible is not empty. If there is no state, the plain-text copy is shown until sync finishes. The collaborative surface is not presented as the document during that time. Only when there is neither a copy nor state is it treated as an empty document.

Nothing is saved until the notice that sync has finished arrives. A debounced save on input, a save on close, and a save on leaving the place all look at the same flag. A document whose flag is not set may be empty. Empty is not written to the source of truth.

This flag is held separately from whether it is shown. Even if a copy is shown and the empty is hidden, a save that runs first makes the hiding meaningless. Writing empty against a sync that did not arrive was the condition that erased contents that were there.

### Updates are sent to open connections

When a connection attaches, it receives the current state of that document. Later updates are applied to the in-memory document and sent to the other connections that have the same name open. They do not wait for the save to finish. Someone who does not have it open reads the saved state the next time they open it. The path for people who have it open, and the path for someone who opens it later, are different.

A connection that cannot write can still attach to the same document. It receives other connections' updates, so the document is visible while it is open. An update that came from that connection is dropped before it is applied. The in-memory document does not change, so it reaches neither the other connections nor the save. Not being able to write is not the same as not being able to see.

Authentication is finished before the document and the save are touched. A connection that does not pass does not receive the contents of the document. After it passes, whether it may write is decided. Here too, having connected and being allowed to write are different.

### The save is a copy

A short wait is placed after the last change, and the encoded state and the plain-text copy are written. The wait is so that a save does not happen on every input. Sync processing does not wait for this write. A slow write does not make the open document slow.

On disconnect, the current in-memory document is saved without waiting out the wait. Input from just after close is not left behind inside the wait. Even if this save fails, the document on the other open connections does not disappear. The failure is recorded, and the next save writes it again.

The plain-text copy is what someone who does not have it open reads, what is shown before sync, and what other processing that needs the full text uses. It is not used for the merge. A document that already has an encoded state is not opened by overwriting it from the copy.

Only a document that has never had state builds an encoded state once from the copy. After that, the in-memory document is the source of truth, and the save is its copy. Even if the copy looks newer, a merge held by an open connection is not undone by the copy.

A read-only connection does not save again the updates it received. A save is a write. If a connection opened in order to look writes the source of truth every time it looks, a permission that cannot write passes on the save side.

## What this makes possible

Even when several people have it open at once, a later write of the full text does not erase an earlier edit. The merge happens on the in-memory document, and that update is sent to open connections. Even if the save is late, a person who has it open can receive the other person's input.

Empty from before sync finishes is not shown as the document. When state is held, it is applied first. When it is not held, the plain-text copy is shown. During that same interval, nothing is saved. An empty local document does not erase the source of truth against a sync that did not arrive.

After a crash, it is opened from the encoded state. A rebuild into plain text happens only when there has never been state. The save on disconnect leaves input from the middle of the wait in the copy. Even if the save fails, the open document itself remains.

A person who cannot write can see updates while it is open. That person's updates reach neither the document nor the save. Having connected, and being allowed to write, come apart.

Fold collaborative editing and the save into one, and simultaneous input, an empty initial state, delivery to people who have it open, and recovery after a crash cannot all be satisfied on the same write at once. They were split because the condition under which editing fails, and the condition under which the copy fails, are different.
