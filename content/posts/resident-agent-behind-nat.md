---
title: "Keeping an Agent Resident Behind NAT"
date: 2026-09-26T20:00:00+09:00
draft: false
tags: ["agents", "networking"]
summary: "Why a resident agent on a machine that cannot open a port keeps install, liveness, and the interactive data path on separate connections."
math: false
---

# Keeping an Agent Resident Behind NAT

If an agent runs only on the machine in front of you, the network barely becomes a design. The process and the person are on the same machine. The trouble starts when the work lives on another machine, that machine sits behind NAT or an organizational boundary, and you cannot open a port to it. You do not administer that network. Writing down an address does not mean the control plane can reach it.

This design does not treat that machine as something you manage continuously. A person is involved only at install time. After that, liveness and identity are kept by a connection the machine itself opens outward. The interactive data path stays separate, and it exists only while a person is there.

## The problem

The question is simple. There is no way to reach in.

The control plane wants to tell whether that installation is alive, whether it can accept work, whether someone stopped it on purpose, or whether it disappeared. If work is pinned to one machine, it should wait there while the machine is silent. Moving it quietly to another machine splits the context that was left in place.

The bytes of the work itself are on the machine. That means file reads and writes, and the input and output of a running process. If the control plane carries those bytes on the machine's behalf, the control plane becomes the data plane. On an API that cannot pin a connection to a particular instance, the stream you opened and the request that created the work do not land in the same place.

The UI on the operating side is closed by a person. If the resident process dies the moment the UI closes, making it resident was pointless. Closing a laptop must not be the same fact as "the machine is gone."

Several people may share one chassis. An SSH destination names the chassis, not the installation. Being able to reach the host, and having reached a particular account's resident process, are different facts.

Where the secret lives is its own problem. A successful install must not become a credential for anyone who can read the process list or the service definition.

A self-reported string is not an identity either. Writing "I am this machine" in a body does not verify anything. Another machine belonging to the same person can take work addressed to the first. Revoking one machine leaves the shared key behind.

## Constraints

The constraints in this design are as follows.

After install, the agent does not listen. Traffic with the control plane is outbound from the machine only. The control plane does not store the machine's network address. A listener on anything other than loopback is refused.

The install path is limited to SSH the person already has. That session is short. The person is at a terminal. If that terminal has no session of theirs, they approve a short code in a browser. Either way, the authority to admit a new machine sits only on a person's session. An automated actor does not hold it.

Control on the same machine goes over a UNIX domain socket. The socket does not leave the host. Each request requires a local token.

The installation proves its identity with a credential issued to that installation. The identifier kept locally is only for finding its own row after a restart. It is not used for authorization. The credential is not placed in process arguments, in the service definition, or in the environment the service manager passes to the process. At install time it is passed on SSH's standard input, and written to a file only the owner can read, with the permissions narrowed before the contents are written, then replaced atomically.

The daemon remains when the UI closes. It stops only on an explicit stop, a stop signal from the OS, or the machine itself stopping. An explicit stop leaves a latch. Restarting the UI, or logging in again, does not clear that stop.

The data plane a person uses later is forwarded, over SSH that person opened, to the UNIX socket on the far side. The control plane does not carry file contents or execution records.

## Approaches this design rejects

### Opening an inbound path

Publishing a port, keeping a reverse tunnel up so the control plane can dial in, or writing a listen address into a registry. The machines in question are exactly the ones that cannot do this. A NAT mapping stays alive for a while only for flows opened from the inside. A new flow started from the outside has nobody to land on.

Even if you opened it, the control plane would have to keep operating addresses and listeners. Mappings expire, addresses change, and the listener is exposed. This design has no agent listener, and it has no address.

### A standing VPN

Put every machine on one network, and both SSH and listeners appear to "reach." They reach because you administer that network. That premise does not hold for a machine you cannot administer.

Other problems remain. A tunnel address is not an installation identity. You rotate a VPN credential and a machine credential. When the laptop sleeps, the path drops and the agent looks dead. The fact you want is whether that installation is alive, whose it is, and whether it can accept work. A live path is not a substitute.

### Keeping SSH as the data plane

SSH fits install, and it fits interaction while a person is present. If liveness and work pickup ride the same session, the machine becomes absent the moment the side holding the session dies. Closing the UI, closing the laptop, or losing a jump host is enough to erase the resident process.

Interactive bytes are needed only while a person is watching. Liveness lasts longer than that. Leaving SSH as the data-plane path, and making SSH the condition of the machine's existence, are different decisions. This design rejects the second.

### Putting the data plane on the liveness check

Carrying file or execution input and output on a short outbound check. If one transfer is slow, the machine looks down. The check must not wait on disk or on a large response.

The control plane also becomes the path for a working copy. The plane is not a place that holds someone else's files or execution records. On an API that cannot pin a connection to one instance, the socket you opened and the request that created the work do not land on the same process. A path that pins a connection in order to push was not a premise of this design.

There was also a proposal to combine liveness and work pickup into one long hold. When the hold drops, and when the machine dies, the outside sees the same silence. A quiet machine also keeps paying to hold the connection. Liveness stays a short check. Work pickup is a separate short outbound request.

### Mounting the far disk locally

Showing the far filesystem to local tools. The agent runs on the far machine. A mount does not create a process there. On a high-latency path, the tools that inspect state in small pieces break first. A terminal does not arrive this way, and neither does a continued execution.

### Sharing a person's credential across machines

Each machine holds a person's key and names itself with an identifier in the body. The identifier is self-reported, so it is not a verification. Revoking one machine leaves the same key, and another machine can take work addressed to the first. The credential is bound to the installation, and kept apart from the person's session.

## The shape of the connection

The connection is split into three layers. SSH only at install time, a machine-originated check that continues after that, and a data plane that comes back only while a person is present.

<img src="/images/resident-agent-layers.en.svg" alt="Install goes from the person to the machine, and only then. The outbound check continues from the machine to the control plane. The data plane goes from the person to the machine only while a person is present." width="425" style="max-width:100%;height:auto;">

### SSH only for install, and only the SSH a person already has

The premise is that the person can SSH to that OS account. The control plane does not hold that path for them.

On the first connection, the host-key fingerprint is shown to the person. The only commands run before that confirmation are ones with no real effect. Neither the credential nor execution input is sent before the confirmation. After it, the key is checked strictly, and a changed key stops the connection.

The artifacts are placed over that verified connection. The signature is checked before the result is handed to the service manager. Later updates also happen on the pre-check when the person connects, and they are deferred while work is running. Updating the ordinary user-facing command does not change the entity this resident process points at.

The credential is passed on standard input. Put it in an argument, and it remains in the process list. Write it into the service definition, or into the environment the service manager reads, and anyone who can read the definition can read the credential. The daemon writes to a temporary file that already has owner-only permissions, syncs, then replaces. An empty file may be visible in the middle. A half-written body must not remain under the credential's name.

Immediately after it is placed, one outbound check uses that credential. Execution control opens only after the row the control plane returns matches the machine currently selected. Three things have to line up. The user SSH authenticated, the pinned host key, and the control-plane row bound to the credential. If the row returned from the far side of the tunnel differs from the row the person selected, that connection does not open execution.

An install with no local UI has the person approve a short code in a browser. The exchange record does not contain the credential itself. A self-report before approval, a name, an account, or an identifier, is a display so the approving person can tell which machine it is. It is not a proof. The pickup after approval happens once. Expiry, refusal, and already-used all look like the same failure from the outside. Distinguishing which one happened would leak internal state to someone who only has the code.

### After that, the machine connects outward

The service manager owns the daemon. Closing the UI does not call stop. The next time the UI opens, it uses the daemon that is already running. Only an explicit stop leaves a latch. Neither the UI nor an OS login clears it and starts the process again.

Some environments need a setting so a user service survives logout. Without it, the daemon dies on logoff. That gap is returned as its own fact, separate from absence: "it is up, but it still cannot accept work." A resident process tied to login, and one that does not need a login, fail differently. Collapsing both into "stopped" erases which one you should fix.

The control API is only that account's UNIX socket. A token is required on every request. Even in an environment where the near end of the forward cannot be a UNIX socket and has to be loopback TCP, the boundary stays on the token. A process that merely reached the port gets only an authentication failure. The token lives in the operator's memory. That side does not write it to disk.

The liveness check is outbound HTTPS. The server returns the interval every time. Bake it into the client, and a machine whose interval you want to change is exactly the one that does not receive a new binary. The floor is on the order of tens of seconds. The check fires without waiting for the interval when the credential is received, when readiness changes, and just before a stop. Only a floor on consecutive checks is kept, so probing does not flap into a hot loop.

The one check just before a stop is what separates "stopped" from "disappeared." That check does not continue the context of work that was already cancelled. It is sent under its own short deadline. The reason carries only a fixed vocabulary: a person's action, an update, a restart, a handoff, a signal, a revocation.

The name, version, readiness, and lifecycle written in the check body are display. They create no authority. Authorization is held only by the credential. Knowing the identifier does not issue a second credential for an installation that already has one. Reissue is either rotation with the current credential, or deletion of the machine. Deletion makes the identifier usable again. Without that, a machine that lost its secret cannot be put back. Claiming an unused identifier in order to obtain a credential requires being able to read the identifier on that machine. The identifier is not published anywhere.

Rotation issues a new generation and does not discard the old one immediately. If the process dies between receiving the new value and storing it, the old key can still check in. The old generation is cut only when the new key has succeeded once. Success is the evidence that it arrived. Letting the old key start the next generation would let a retained old key begin a separate generation line. Only the generation that is valid now may start a rotation.

Revocation, and a rotation that is merely behind, are distinguished in the response. When the machine has been deleted, the loop stops and waits. The identifier has been released, so the person can admit it again. Meanwhile the daemon does not keep checking into the void. If the key was cut only because it is a generation behind, it retries with the key it holds, spaced by the interval. Collapse those two into the same "unknown key," and deletion goes back to being a row hidden from a list.

Readiness is not a boolean the daemon asserts. The control plane interprets a code that names what is blocking. Liveness is decided only by the time since the last check. Newer than about two minutes is present, older than that is absent, and never seen is not-yet-arrived. Lifecycle is the pair of what it last said and whether it has kept checking since. It counts as stopped only when it said stopped and then went silent. Silence after it said running is unknown, not stopped. A crash, sleep, and a dead network all look the same there. A self-report about the future is not stored.

The display name is adopted once, on the first check that carries a name. The daemon periodically sends the OS hostname. Overwriting with that every time lets the machine undo a name a person set. A missing reading right after startup, before probing has finished, is not read as "nothing is blocking." The stored blocker and readiness are left as they are.

A request from the control plane to the machine rides on the liveness response. There is no path to dial. A request such as "I want the tail of the log" is written on the row as a timestamp. The daemon sees that timestamp on its next response. The upload is a separate outbound send, outside the check. If the check waits on the transfer, a slow disk looks offline. A resend for the same timestamp happens only once, and only a failure retries on the next check. If the response still carries the same timestamp but the upload already succeeded, it is not sent again. The request is cleared only when the timestamp that was asked for matches the timestamp the upload echoed. If another request overlaps in the middle, the earlier upload does not clear the later request. A request while the machine is stopped is not a failure. It arrives the next time a check comes back.

Work pickup is also a short request originated by the machine. It is separate from the liveness check. The cost of a quiet machine scales with the number of machines, not with the number of directories being watched. One machine may watch several places, and one liveness connection is enough. Work whose destination is pinned to this installation waits here while the machine is silent.

### The data plane is SSH, and only while a person is present

When a person interacts with that machine, an existing SSH forward lands on the far UNIX socket. Rather than starting a new TCP connection or a cryptographic handshake on every request, a channel is added on the connection that is already up. The cost is close to one round trip per call. Reads and writes at the pace of a person are enough. Change notifications are watched on the far machine and flow back. The far side is not periodically reread in full.

The forward reaches only the socket of the authenticated OS account. Another account on the same chassis has another socket, another credential, and another row. Sharing a chassis does not cross accounts. Which workspace is shown is authorized separately from the machine credential. The machine belongs to a person, and a workspace can see only the directories bound to it. It is not used as a list of other workspaces.

The SSH destination and the host key stay on the operating side. They are not the control plane's identity. While the person cannot SSH, liveness checks and work pickup continue outbound. Only the data plane waits until that person's path comes back.

## What this makes possible

An installation behind NAT can be counted as one machine, and its liveness can be seen, without opening a port and without a standing VPN. The control plane holds no address, so when a NAT mapping expires, the next outbound check restores the relationship.

The daemon remains when the UI closes. Closing it is not a stop. An intentional stop, a revocation, and a plain disappearance do not collapse into the same "not visible." "Present, but cannot accept work" can be returned as a sentence distinct from absence.

Delete one machine, and that credential cannot act from then on. If deletion and revocation are left as separate remaining facts, the next check undoes the deletion.

Something you cannot enter now but want the next time it happens, such as a log, can be requested without dialing. The request arrives on the check response, and the answer comes back as a separate send from the machine.

While a person is connected, the data plane can ride that SSH. While they are not, the machine's liveness, and the wait for work that was pinned, remain.

The secret does not appear in the process list or in the service definition. Admitting a new machine stays inside a person's action. Another account on the same chassis can be treated as another machine.

Fold the shape of the connection into one path, and unreachability, a short session, the size of the data plane, and the strength of identity cannot all be satisfied on that path at once. They were split because each one fails under a different condition.
